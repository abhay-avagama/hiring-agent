import { readFile } from "node:fs/promises";
import { atomicJson } from "./atomic-file.ts";
import { mergeEnrichmentLeads, type EnrichmentLead } from "./enrichment-registry.ts";
import { fetchSafeHead, type HeadTransport, type ResolveHost } from "./safe-head.ts";
import { resolveSource } from "./source-verification.ts";

/**
 * Employer names from a hiring signal (Adzuna, Jooble) become board leads by guessing the provider token from the name
 * and letting the provider confirm it exists. Nothing is admitted here: every hit is a lead for the board tier, which
 * verifies identity against the provider's own record before anything is crawled.
 */
export interface ResolverSignal { companyName: string; jobs: number }
export interface ResolverReport { generatedAt: string; employers: number; probed: number; requests: number; found: number; byProvider: Record<string, number>; leads: Array<{ companyName: string; sourceUrl: string; ats: string }>; unresolved: string[] }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const WORKDAY_HOSTS = ["wd1", "wd3", "wd5", "wd12", "wd103", "wd108", "wd10", "wd2"];
const STOP = new Set(["the", "inc", "llc", "ltd", "limited", "pvt", "private", "corp", "corporation", "company", "co", "group", "india", "technologies", "technology", "solutions", "services", "global", "international", "bank", "plc", "lp", "llp", "and", "of"]);

/** Token guesses in order of likelihood: full compact name, hyphenated name, distinctive first word. */
export function tokenGuesses(name: string): string[] {
  const words = name.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const core = words.filter((word) => !STOP.has(word));
  const base = core.length ? core : words;
  const guesses = [base.join(""), base.join("-"), base[0] ?? ""].filter((guess) => guess.length >= 3);
  if (base.length > 2) guesses.push(base.slice(0, 2).join(""));
  return [...new Set(guesses)];
}

export async function resolveEmployers(signalsPath: string, options: { catalogPath?: string; registryPath?: string; reportPath?: string; minJobs?: number; limit?: number; concurrency?: number; fetcher?: Fetch; headTransport?: HeadTransport; resolveHost?: ResolveHost; timeoutMs?: number } = {}): Promise<ResolverReport> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const signals = JSON.parse(await readFile(signalsPath, "utf8")) as { employers: ResolverSignal[] };
  const known = new Set<string>();
  if (options.catalogPath) for (const entry of Object.values(JSON.parse(await readFile(options.catalogPath, "utf8")) as Record<string, { name: string; companyDomain?: string }>)) { known.add(compact(entry.name)); if (entry.companyDomain) known.add(compact(entry.companyDomain.split(".")[0]!)); }
  let employers = signals.employers.filter((entry) => entry.jobs >= (options.minJobs ?? 1) && !known.has(compact(entry.companyName)));
  if (options.limit) employers = employers.slice(0, options.limit);
  const report: ResolverReport = { generatedAt: new Date().toISOString(), employers: signals.employers.length, probed: employers.length, requests: 0, found: 0, byProvider: {}, leads: [], unresolved: [] };
  const timeout = options.timeoutMs ?? 12_000;
  const seenSources = new Set<string>();
  const ok = async (url: string, init?: RequestInit) => { report.requests += 1; try { const reply = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeout) }); await reply.body?.cancel().catch(() => undefined); return reply; } catch { return null; } };
  const probes: Array<(guess: string) => Promise<string | null>> = [
    async (guess) => { for (const host of WORKDAY_HOSTS) { report.requests += 1; try { const head = await fetchSafeHead(`https://${guess}.${host}.myworkdayjobs.com/`, { timeoutMs: timeout, transport: options.headTransport, resolveHost: options.resolveHost }); if (head.response.ok && resolveSource(head.finalUrl)?.ats === "workday") return head.finalUrl; } catch { /* no such tenant */ } } return null; },
    async (guess) => { const reply = await ok(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(guess)}/jobs`); return reply?.ok ? `https://job-boards.greenhouse.io/${guess}` : null; },
    async (guess) => { const reply = await ok(`https://api.lever.co/v0/postings/${encodeURIComponent(guess)}?mode=json`); return reply?.ok ? `https://jobs.lever.co/${guess}` : null; },
    async (guess) => { const reply = await ok(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(guess)}`); return reply?.ok ? `https://jobs.ashbyhq.com/${guess}` : null; },
    async (guess) => { // SmartRecruiters answers 200 with an empty list for any name, so only a posting proves the company exists
      report.requests += 1;
      try { const reply = await fetcher(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(guess)}/postings?limit=1`, { signal: AbortSignal.timeout(timeout) }); if (!reply.ok) { await reply.body?.cancel().catch(() => undefined); return null; } const body = await reply.json() as { totalFound?: number }; return (body.totalFound ?? 0) > 0 ? `https://jobs.smartrecruiters.com/${guess}` : null; } catch { return null; }
    },
    async (guess) => { const reply = await ok(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(guess)}`); return reply?.ok ? `https://apply.workable.com/${guess}/` : null; },
    async (guess) => { if (!/^[a-z0-9-]+$/.test(guess)) return null; const reply = await ok(`https://${guess}.keka.com/careers`); if (!reply?.ok) return null; try { const shell = await (await fetcher(`https://${guess}.keka.com/careers`, { signal: AbortSignal.timeout(timeout) })).text(); const org = /\/ats\/documents\/([0-9a-f-]{36})\//i.exec(shell)?.[1]; return org ? `https://${guess}.keka.com/careers/api/embedjobs/default/active/${org.toLowerCase()}` : null; } catch { return null; } },
  ];
  const leads: EnrichmentLead[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < employers.length) {
      const employer = employers[cursor++]!;
      let hit: string | null = null;
      for (const guess of tokenGuesses(employer.companyName)) {
        for (const probe of probes) { hit = await probe(guess); if (hit) break; }
        if (hit) break;
      }
      const source = hit ? resolveSource(hit) : null;
      if (!source) { report.unresolved.push(employer.companyName); continue; }
      const sourceKey = `${source.ats}:${source.token.toLowerCase()}`;
      if (seenSources.has(sourceKey)) continue;
      seenSources.add(sourceKey);
      report.found += 1; report.byProvider[source.ats] = (report.byProvider[source.ats] ?? 0) + 1;
      report.leads.push({ companyName: employer.companyName, sourceUrl: source.canonicalSourceUrl, ats: source.ats });
      leads.push({ sourceKey, sourceUrl: source.canonicalSourceUrl, ats: source.ats, token: source.token, discoveredFrom: [{ channel: "search", reference: `hiring-signal:${employer.companyName}` }], companyMatches: [], identityEvidence: [], attempts: [] });
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 6) }, worker));
  if (options.registryPath && leads.length) await mergeEnrichmentLeads(options.registryPath, leads);
  if (options.reportPath) await atomicJson(options.reportPath, report);
  return report;
}

function compact(value: string): string { return value.toLowerCase().replace(/\b(inc|llc|ltd|limited|pvt|private|corp|corporation|company|group|india|the)\b/g, "").replace(/[^a-z0-9]/g, ""); }
