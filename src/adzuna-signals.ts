import { atomicJson } from "./atomic-file.ts";

/**
 * Adzuna as an employer signal for one country: which employers have posted recently and how much. Jobs are never
 * ingested from it; names and dates feed the employer resolver. The trial plan allows 25 hits a minute and 250 a day,
 * so every run takes a hit budget and paces itself.
 */
export interface AdzunaEmployer { companyName: string; jobs: number; newestCreated?: string; categories: string[]; locations: string[] }
export interface AdzunaSignalReport { generatedAt: string; country: string; hits: number; jobsSeen: number; totalReported: number; employers: AdzunaEmployer[] }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const ADZUNA_KEYWORDS = ["", "engineer", "developer", "software", "manager", "analyst", "sales", "marketing", "executive", "accountant", "finance", "designer", "data", "support", "operations", "recruiter", "consultant", "nurse", "teacher", "technician", "intern", "product", "quality", "customer", "associate", "java", "python", "react", "devops", "testing"];

export async function collectAdzunaSignals(appId: string, appKey: string, outputPath: string, options: { country?: string; keywords?: string[]; maxHits?: number; maxPages?: number; fetcher?: Fetch; delayMs?: number; sleep?: (ms: number) => Promise<void>; maxDaysOld?: number } = {}): Promise<AdzunaSignalReport> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const country = (options.country ?? "in").toLowerCase();
  const maxHits = options.maxHits ?? 200;
  const employers = new Map<string, AdzunaEmployer>();
  const seen = new Set<string>();
  let hits = 0; let totalReported = 0;
  outer: for (const keywords of options.keywords ?? ADZUNA_KEYWORDS) {
    for (let page = 1; page <= (options.maxPages ?? 10); page += 1) {
      if (hits >= maxHits) break outer;
      if (hits > 0) await sleep(options.delayMs ?? 2_600); // 25 hits a minute
      hits += 1;
      const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}`);
      url.searchParams.set("app_id", appId); url.searchParams.set("app_key", appKey);
      url.searchParams.set("results_per_page", "50"); url.searchParams.set("content-type", "application/json");
      url.searchParams.set("max_days_old", String(options.maxDaysOld ?? 30));
      if (keywords) url.searchParams.set("what", keywords);
      const response = await fetcher(url.href, { signal: AbortSignal.timeout(30_000) });
      if (response.status === 429) break outer;
      if (!response.ok) break;
      const body = await response.json() as { count?: number; results?: Array<Record<string, unknown>> };
      if (page === 1) totalReported = Math.max(totalReported, body.count ?? 0);
      const results = body.results ?? [];
      for (const job of results) {
        const id = String(job.id ?? job.redirect_url ?? "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const company = isRecord(job.company) ? String(job.company.display_name ?? "").trim() : "";
        if (company.length < 2) continue;
        const key = company.toLowerCase();
        const entry = employers.get(key) ?? { companyName: company, jobs: 0, categories: [], locations: [] };
        entry.jobs += 1;
        const created = typeof job.created === "string" ? job.created : undefined;
        if (created && (!entry.newestCreated || created > entry.newestCreated)) entry.newestCreated = created;
        const category = isRecord(job.category) ? String(job.category.label ?? "") : "";
        if (category && !entry.categories.includes(category)) entry.categories.push(category);
        const area = isRecord(job.location) && Array.isArray(job.location.area) ? String(job.location.area[job.location.area.length - 1] ?? "") : "";
        if (area && !entry.locations.includes(area) && entry.locations.length < 5) entry.locations.push(area);
        employers.set(key, entry);
      }
      if (results.length < 50) break;
    }
  }
  const report: AdzunaSignalReport = { generatedAt: new Date().toISOString(), country, hits, jobsSeen: seen.size, totalReported, employers: [...employers.values()].sort((left, right) => right.jobs - left.jobs) };
  await atomicJson(outputPath, report);
  return report;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
