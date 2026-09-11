import { readFile } from "node:fs/promises";
import { atomicJson } from "./atomic-file.ts";

/**
 * A rolling 30-day map of who is hiring in a country, built from Adzuna within its search allowance. Each run
 * samples pages spread evenly across the last day's postings (newest first), so bursts from one employer do not
 * crowd out the rest, and merges them into a state file keyed by Adzuna's posting id. Jobs are never ingested;
 * the map only says which employers are hiring, how much, and whether our catalog covers them.
 */
export interface MarketEmployer { name: string; postings: number; firstSeen: string; lastSeen: string; cities: Record<string, number>; categories: Record<string, number> }
export interface MarketState { country: string; updatedAt: string; runs: number; hitsUsed: number; seen: Record<string, { employer: string; created: string }>; employers: Record<string, MarketEmployer> }
export interface MarketCoverage { employers: number; postings: number; coveredEmployers: number; coveredPostings: number; uncovered: Array<{ name: string; postings: number; cities: string[] }> }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function sampleAdzunaMarket(appId: string, appKey: string, statePath: string, options: { country?: string; maxHits?: number; fetcher?: Fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date; delayMs?: number } = {}): Promise<{ state: MarketState; hits: number; dayTotal: number; newPostings: number; newEmployers: number }> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const country = (options.country ?? "in").toLowerCase();
  const state: MarketState = await readFile(statePath, "utf8").then((text) => JSON.parse(text) as MarketState).catch(() => ({ country, updatedAt: "", runs: 0, hitsUsed: 0, seen: {}, employers: {} }));
  const maxHits = Math.max(1, options.maxHits ?? 75);
  const search = async (page: number) => {
    const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}`);
    for (const [key, value] of Object.entries({ app_id: appId, app_key: appKey, results_per_page: "50", "content-type": "application/json", max_days_old: "1", sort_by: "date" })) url.searchParams.set(key, value);
    const response = await fetcher(url.href, { signal: AbortSignal.timeout(30_000) });
    if (response.status === 429) throw new Error("Adzuna allowance reached");
    if (!response.ok) throw new Error(`Adzuna HTTP ${response.status}`);
    return await response.json() as { count?: number; results?: Array<Record<string, unknown>> };
  };
  let hits = 0; let newPostings = 0; let newEmployers = 0;
  const absorb = (results: Array<Record<string, unknown>>) => {
    for (const job of results) {
      const id = String(job.id ?? ""); if (!id || state.seen[id]) continue;
      const name = isRecord(job.company) ? String(job.company.display_name ?? "").trim() : "";
      if (name.length < 2) continue;
      const key = name.toLowerCase();
      const created = typeof job.created === "string" ? job.created : now().toISOString();
      state.seen[id] = { employer: key, created }; newPostings += 1;
      const employer = state.employers[key] ?? (newEmployers += 1, { name, postings: 0, firstSeen: created, lastSeen: created, cities: {}, categories: {} });
      employer.postings += 1;
      if (created > employer.lastSeen) employer.lastSeen = created;
      const area = isRecord(job.location) && Array.isArray(job.location.area) ? String(job.location.area[job.location.area.length - 1] ?? "") : "";
      if (area) employer.cities[area] = (employer.cities[area] ?? 0) + 1;
      const category = isRecord(job.category) ? String(job.category.label ?? "") : "";
      if (category) employer.categories[category] = (employer.categories[category] ?? 0) + 1;
      state.employers[key] = employer;
    }
  };
  const first = await search(1); hits += 1; absorb(first.results ?? []);
  const dayTotal = first.count ?? 0;
  const pages = Math.max(1, Math.ceil(dayTotal / 50));
  // Spread the remaining allowance evenly across the day's pages.
  const picks = new Set<number>();
  for (let index = 1; index < Math.min(maxHits, pages); index += 1) picks.add(1 + Math.round((index * (pages - 1)) / Math.max(1, Math.min(maxHits, pages) - 1)));
  picks.delete(1);
  for (const page of [...picks].sort((left, right) => left - right)) {
    if (hits >= maxHits) break;
    await sleep(options.delayMs ?? 2_600); // Adzuna allows 25 searches a minute
    try { absorb((await search(page)).results ?? []); hits += 1; }
    catch (error) { hits += 1; if (String(error).includes("allowance")) break; }
  }
  // Keep a rolling 30 days: postings older than that drop out of both the dedupe set and the employer counts.
  const cutoff = new Date(now().getTime() - 30 * 86_400_000).toISOString();
  for (const [id, entry] of Object.entries(state.seen)) {
    if (entry.created >= cutoff) continue;
    delete state.seen[id];
    const employer = state.employers[entry.employer];
    if (employer && --employer.postings <= 0) delete state.employers[entry.employer];
  }
  state.updatedAt = now().toISOString(); state.runs += 1; state.hitsUsed += hits;
  await atomicJson(statePath, state);
  return { state, hits, dayTotal, newPostings, newEmployers };
}

const STOP = new Set(["the", "inc", "llc", "ltd", "limited", "pvt", "private", "corp", "corporation", "company", "co", "group", "india", "technologies", "technology", "solutions", "services", "global", "international", "plc", "llp", "and", "of", "com"]);
function keysFor(name: string): string[] {
  const words = name.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const core = words.filter((word) => !STOP.has(word));
  const base = core.length ? core : words;
  const full = base.join("");
  // A short whole name (JLL, MSD, ABB) is still a name; only a lone first word needs four letters to avoid false matches.
  return [...new Set([full, words.join(""), ...(ALIASES[full] ?? []), ...(base[0] && base[0].length >= 4 ? [base[0]] : [])].filter((key) => key.length >= 2))];
}
/** Employers our catalog knows under a provider tenant that looks nothing like the name Adzuna shows. */
const ALIASES: Record<string, string[]> = { pricewaterhousecoopers: ["pwc"], deutschebank: ["db"], standardchartered: ["standard"], spglobal: ["spgi"], jonesianglasalle: ["jll"], merck: ["msd"], johnsonandjohnson: ["jj"], wellsfargo: ["wf"], northropgrumman: ["ngc"] };

/** Which of the market's employers the catalog covers, matched on slugs, names, provider tenants, and company domains. */
export function marketCoverage(state: MarketState, catalog: Record<string, { name: string; token: string; companyDomain?: string }>, limit = 50): MarketCoverage {
  const known = new Set<string>();
  const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [slug, entry] of Object.entries(catalog)) for (const key of [slug, entry.name, entry.token.split("/")[0]!.split(".")[0]!, (entry.companyDomain ?? "").split(".")[0]!]) { const value = squash(key); if (value.length >= 3) known.add(value); }
  const employers = Object.values(state.employers);
  const covered = employers.filter((employer) => keysFor(employer.name).some((key) => known.has(key)));
  const coveredSet = new Set(covered);
  return {
    employers: employers.length, postings: employers.reduce((sum, employer) => sum + employer.postings, 0),
    coveredEmployers: covered.length, coveredPostings: covered.reduce((sum, employer) => sum + employer.postings, 0),
    uncovered: employers.filter((employer) => !coveredSet.has(employer)).sort((left, right) => right.postings - left.postings).slice(0, limit)
      .map((employer) => ({ name: employer.name, postings: employer.postings, cities: Object.entries(employer.cities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([city]) => city) })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
