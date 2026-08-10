import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mergeSourceCandidates } from "./source-discovery.ts";
import { resolveSource } from "./source-verification.ts";
import { fetchSafeHead, type HeadTransport, type ResolveHost } from "./safe-head.ts";
import type { SourceCandidate } from "./types.ts";

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface CompanySeed { companyName: string; companyDomain: string; careerUrl?: string }
interface TraceIssue { companyName?: string; companyDomain?: string; careerUrls?: string[]; reason: string; detail: string }
interface TraceOptions { country?: string; fetch?: Fetch; concurrency?: number; timeoutMs?: number; searchKey?: string; commonCrawlReportPath?: string; resolveHost?: ResolveHost; headTransport?: HeadTransport }

export interface CareerTraceReport {
  companiesChecked: number;
  ready: number;
  alreadyKnown: number;
  unresolved: number;
  rejected: number;
  failures: number;
  candidatesPath: string;
  reportPath: string;
  unresolvedCompanies: TraceIssue[];
  rejections: TraceIssue[];
  failureDetails: TraceIssue[];
}

export async function traceCareerSources(inputPath: string, candidatesPath: string, reportPath: string, options: TraceOptions = {}): Promise<CareerTraceReport> {
  const seeds = await readSeeds(inputPath);
  const fetcher = options.fetch ?? globalThis.fetch;
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 10));
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 15_000));
  const country = options.country?.toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw new Error("country must be a two-letter code");
  const candidates: Array<{ index: number; candidate: SourceCandidate }> = [];
  const commonCrawlLeads = options.commonCrawlReportPath ? await readCommonCrawlLeads(options.commonCrawlReportPath) : [];
  const unresolved: Array<{ index: number; issue: TraceIssue }> = [];
  const rejected: Array<{ index: number; issue: TraceIssue }> = [];
  const failures: Array<{ index: number; issue: TraceIssue }> = [];
  let cursor = 0;

  async function worker() {
    while (cursor < seeds.length) {
      const index = cursor++;
      const seed = seeds[index]!;
      const invalid = validateSeed(seed);
      if (invalid) { rejected.push({ index, issue: { ...identity(seed), reason: "invalid_company", detail: invalid } }); continue; }
      const careerUrls = seed.careerUrl ? [seed.careerUrl] : ["careers", "career", "jobs"].map((path) => `https://${seed.companyDomain}/${path}`);
      let found: ReturnType<typeof resolveSource> = null;
      let reference = careerUrls[0]!;
      let channel: "career_page" | "search" | "dataset" = "career_page";
      if (options.searchKey) {
        try {
          const result = await searchForSource(seed, options.searchKey, fetcher, country);
          if (result) { found = result.source; reference = result.reference; channel = "search"; }
        } catch (error) {
          failures.push({ index, issue: { ...identity(seed), reason: "search_failed", detail: error instanceof Error ? error.message : String(error) } });
        }
      }
      if (!found) {
        for (const careerUrl of careerUrls) {
          try {
            const result = await fetchSafeHead(careerUrl, { resolveHost: options.resolveHost, transport: options.headTransport, timeoutMs });
            if (!result.response.ok) continue;
            const source = resolveSource(result.finalUrl);
            if (source) { found = source; reference = careerUrl; break; }
          } catch (error) {
            failures.push({ index, issue: { ...identity(seed), careerUrls: [careerUrl], reason: "career_request_failed", detail: error instanceof Error ? error.message : String(error) } });
          }
        }
      }
      if (!found) {
        const lead = commonCrawlLeads.find((item) => sourceMatchesCompany(item.source.token, seed));
        if (lead) { found = lead.source; reference = lead.reference; channel = "dataset"; }
      }
      if (!found) {
        unresolved.push({ index, issue: { ...identity(seed), careerUrls, reason: "ats_not_resolved", detail: "Career URLs did not redirect to a supported structured job source" } });
        continue;
      }
      candidates.push({ index, candidate: {
        companyName: seed.companyName.trim(), companyDomain: normalizeDomain(seed.companyDomain), sourceUrl: found.canonicalSourceUrl,
        cohorts: country ? [country] : undefined,
        discoveredFrom: { channel, reference },
        domainEvidence: channel === "career_page" ? { kind: "company_redirect", reference } : undefined,
      } });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, seeds.length) }, worker));
  const additions = candidates.sort((a, b) => a.index - b.index).map((row) => row.candidate);
  const appended = await mergeSourceCandidates(candidatesPath, additions);
  const report: CareerTraceReport = {
    companiesChecked: seeds.length, ready: appended, alreadyKnown: additions.length - appended,
    unresolved: unresolved.length, rejected: rejected.length, failures: failures.length, candidatesPath, reportPath,
    unresolvedCompanies: unresolved.sort((a, b) => a.index - b.index).map((row) => row.issue),
    rejections: rejected.sort((a, b) => a.index - b.index).map((row) => row.issue),
    failureDetails: failures.sort((a, b) => a.index - b.index).map((row) => row.issue),
  };
  await atomicJson(reportPath, report);
  return report;
}

async function readCommonCrawlLeads(path: string) {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value) || !Array.isArray(value.leads)) throw new Error("Common Crawl report must contain a leads array");
  return value.leads.flatMap((lead) => {
    if (!isRecord(lead) || typeof lead.sourceUrl !== "string") return [];
    const source = resolveSource(lead.sourceUrl);
    if (!source) return [];
    const reference = isRecord(lead.discoveredFrom) && typeof lead.discoveredFrom.reference === "string" ? lead.discoveredFrom.reference : path;
    return [{ source, reference }];
  });
}

async function searchForSource(seed: CompanySeed, key: string, fetcher: Fetch, country?: string) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", `\"${seed.companyName}\" (site:job-boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com OR site:myworkdayjobs.com)`);
  url.searchParams.set("count", "20");
  if (country) url.searchParams.set("country", country);
  const response = await fetcher(url, { headers: { Accept: "application/json", "X-Subscription-Token": key } });
  if (!response.ok) throw new Error(`Brave Search returned HTTP ${response.status}`);
  const value: unknown = await response.json();
  const results = isRecord(value) && isRecord(value.web) && Array.isArray(value.web.results) ? value.web.results : [];
  for (const result of results) {
    if (!isRecord(result) || typeof result.url !== "string") continue;
    const source = resolveSource(result.url);
    if (source && sourceMatchesCompany(source.token, seed)) return { source, reference: result.url };
  }
  return null;
}

async function readSeeds(path: string): Promise<CompanySeed[]> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error("Company input must be a JSON array of objects");
  return value as unknown as CompanySeed[];
}

function validateSeed(seed: CompanySeed): string | null {
  if (typeof seed.companyName !== "string" || !seed.companyName.trim()) return "companyName is required";
  if (typeof seed.companyDomain !== "string" || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(seed.companyDomain)) return "companyDomain must be a hostname";
  if (seed.careerUrl !== undefined) {
    try {
      const url = new URL(seed.careerUrl);
      if (url.protocol !== "https:") return "careerUrl must use HTTPS";
      const domain = normalizeDomain(seed.companyDomain);
      const host = normalizeDomain(url.hostname);
      if (host !== domain && !host.endsWith(`.${domain}`)) return "careerUrl must belong to companyDomain";
    }
    catch { return "careerUrl must be a valid URL"; }
  }
  return null;
}

function normalizeDomain(value: string): string { return value.toLowerCase().replace(/^www\./, ""); }
function sourceMatchesCompany(token: string, seed: CompanySeed): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/\b(inc|llc|ltd|limited|corp|corporation|company)\b/g, "").replace(/[^a-z0-9]/g, "");
  const workdayTenant = token.includes("myworkdayjobs.com/") ? token.split("/")[1] : undefined;
  const source = normalize(workdayTenant ?? token);
  const name = normalize(seed.companyName);
  const domain = normalize(normalizeDomain(seed.companyDomain).split(".")[0] ?? "");
  return source.length >= 3 && (source === name || source === domain);
}
function identity(seed: Partial<CompanySeed>) { return { companyName: seed.companyName, companyDomain: seed.companyDomain }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}
