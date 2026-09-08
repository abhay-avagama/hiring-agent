import { atomicJson } from "./atomic-file.ts";

/**
 * Jooble as an employer signal, never as a job source: who is hiring right now, and on which site the posting originated.
 * When the origin site is a company-owned host it doubles as the employer's domain, which the site and board tracers verify.
 */
export interface JoobleSignal { companyName: string; jobs: number; newestUpdated?: string; sources: string[]; companyDomain?: string }
export interface JoobleSignalReport { generatedAt: string; location: string; queries: number; jobsSeen: number; employers: JoobleSignal[]; seeds: Array<{ companyName: string; companyDomain: string }> }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const AGGREGATOR_HOSTS = /jooble|indeed|linkedin|glassdoor|naukri|monster|shine|timesjobs|foundit|hireskys|decentrajobs|jobrapido|talent\.com|adzuna|careerjet|neuvoo|whatjobs|jobisjob|trovit|mitula|jora|recruit\.net|simplyhired|ziprecruiter|lensa|bebee|learn4good|expertini|workable|greenhouse|lever|ashby|smartrecruiters|myworkdayjobs|recruitee|breezy|freshteam|keka|zohorecruit|jobvite|icims|taleo|successfactors|bamboohr|applytojob|jazzhr/i;
export const DEFAULT_KEYWORDS = ["", "engineer", "developer", "software", "manager", "analyst", "sales", "marketing", "executive", "accountant", "finance", "designer", "data", "support", "operations", "hr", "consultant", "nurse", "teacher", "technician", "intern", "product", "quality", "customer", "associate"];

export async function collectJoobleSignals(apiKey: string, outputPath: string, options: { location?: string; keywords?: string[]; maxPages?: number; fetcher?: Fetch; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<JoobleSignalReport> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const location = options.location ?? "India";
  const employers = new Map<string, JoobleSignal>();
  let queries = 0; let jobsSeen = 0;
  const seen = new Set<string>();
  for (const keywords of options.keywords ?? DEFAULT_KEYWORDS) {
    for (let page = 1; page <= (options.maxPages ?? 10); page += 1) {
      if (queries > 0 && options.delayMs) await sleep(options.delayMs);
      queries += 1;
      const response = await fetcher(`https://jooble.org/api/${encodeURIComponent(apiKey)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keywords, location, page, ResultOnPage: 100 }), signal: AbortSignal.timeout(30_000) });
      if (!response.ok) break;
      const body = await response.json() as { totalCount?: number; jobs?: Array<Record<string, unknown>> };
      const jobs = body.jobs ?? [];
      for (const job of jobs) {
        const id = String(job.id ?? job.link ?? "");
        if (!id || seen.has(id)) continue;
        seen.add(id); jobsSeen += 1;
        const name = String(job.company ?? "").trim();
        if (!name || name.length < 2) continue;
        const key = name.toLowerCase();
        const entry = employers.get(key) ?? { companyName: name, jobs: 0, sources: [] };
        entry.jobs += 1;
        const updated = typeof job.updated === "string" ? job.updated : undefined;
        if (updated && (!entry.newestUpdated || updated > entry.newestUpdated)) entry.newestUpdated = updated;
        const source = String(job.source ?? "").toLowerCase().replace(/^www\./, "");
        if (source && !entry.sources.includes(source)) entry.sources.push(source);
        employers.set(key, entry);
      }
      if (jobs.length < 100 || seen.size >= (body.totalCount ?? 0)) break;
    }
  }
  for (const entry of employers.values()) {
    const owned = entry.sources.find((host) => !AGGREGATOR_HOSTS.test(host) && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host));
    if (owned) entry.companyDomain = registrable(owned);
  }
  const list = [...employers.values()].sort((left, right) => right.jobs - left.jobs);
  const report: JoobleSignalReport = { generatedAt: new Date().toISOString(), location, queries, jobsSeen, employers: list, seeds: list.filter((entry) => entry.companyDomain).map((entry) => ({ companyName: entry.companyName, companyDomain: entry.companyDomain! })) };
  await atomicJson(outputPath, report);
  return report;
}

/** careers-inc.nttdata.com -> nttdata.com; keeps two labels under a two-letter country suffix such as co.in. */
function registrable(host: string): string {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const last = parts[parts.length - 1]!; const second = parts[parts.length - 2]!;
  return last.length === 2 && ["co", "com", "org", "net", "ac", "gov", "edu"].includes(second) ? parts.slice(-3).join(".") : parts.slice(-2).join(".");
}
