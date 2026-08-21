import type { Company, Job, JobSummary, SearchQuery } from "./types.ts";
import { classifyJob, isEligibleForCountry, normalizeLocation } from "./locations.ts";

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface Catalog {
  search(query: SearchQuery): Promise<JobSummary[]>;
  get(id: string): Promise<Job | null>;
}

interface CatalogOptions {
  companies: Company[];
  fetch?: Fetch;
  cacheTtlMs?: number;
}

interface GreenhouseJob {
  id: number;
  title: string;
  location: { name: string };
  absolute_url: string;
  updated_at?: string;
  content?: string;
}

interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  categories?: { location?: string };
  descriptionPlain?: string;
  workplaceType?: string;
  createdAt?: number;
}

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  isRemote?: boolean;
  jobUrl: string;
  descriptionPlain?: string;
  publishedAt?: string;
}

interface WorkdayJob {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}

interface RecruiteeJob {
  guid: string;
  title: string;
  city?: string;
  state_name?: string;
  country_code?: string;
  remote?: boolean;
  hybrid?: boolean;
  on_site?: boolean;
  careers_url: string;
  updated_at?: string;
  published_at?: string;
  description?: string;
  requirements?: string;
  translations?: Record<string, { description?: string; requirements?: string; title?: string }>;
}

export function createCatalog(options: CatalogOptions): Catalog {
  const fetcher = options.fetch ?? globalThis.fetch;
  const cache = new Map<string, { expiresAt: number; jobs: Promise<Job[]> }>();

  async function fetchJobs(company: Company): Promise<Job[]> {
    const cached = cache.get(company.slug);
    if (cached && cached.expiresAt > Date.now()) return cached.jobs;
    const jobs = fetchSourceJobs(company, fetcher);
    cache.set(company.slug, { expiresAt: Date.now() + (options.cacheTtlMs ?? 5 * 60_000), jobs });
    try {
      return await jobs;
    } catch (error) {
      cache.delete(company.slug);
      throw error;
    }
  }

  return {
    async search(query) {
      const jobs = (await Promise.all(options.companies.map((company) => fetchJobs(company).catch(() => [])))).flat();

      return searchJobs(jobs, query);
    },
    async get(id) {
      const [ats, slug] = id.split(":", 3);
      const company = options.companies.find((candidate) => candidate.ats === ats && candidate.slug === slug);
      if (!company) return null;
      let job = (await fetchJobs(company)).find((candidate) => candidate.id === id) ?? null;
      if (job && company.ats === "workday" && !job.description.trim()) {
        const description = await fetchWorkdayDescription(company, job.url, fetcher);
        job = { ...job, description };
      }
      if (job && !job.description.trim()) throw new Error(`Full description unavailable for job: ${id}`);
      return job;
    },
  };
}

export function searchJobs(jobs: Job[], query: SearchQuery): JobSummary[] {
  return jobs.filter((job) => matches(job, query)).slice(0, query.limit ?? 50).map(toSummary);
}

export interface FetchJobsObserver {
  onBackoff?(event: { status: number; delayMs: number }): void;
  workdayPageDelayMs?: number;
  pacingNow?: () => number;
  pacingSleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}
export async function fetchSourceJobs(company: Company, fetcher: Fetch = globalThis.fetch, signal?: AbortSignal, observer?: FetchJobsObserver): Promise<Job[]> {
  if (company.ats === "workday") return fetchWorkdayJobs(company, fetcher, signal, observer);
  const url = company.ats === "greenhouse"
    ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.token)}/jobs?content=true`
    : company.ats === "lever"
      ? `https://api.lever.co/v0/postings/${encodeURIComponent(company.token)}?mode=json`
      : company.ats === "ashby"
        ? `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company.token)}`
        : `https://${encodeURIComponent(company.token)}.recruitee.com/api/offers`;
  const response = await fetchWithRetry(fetcher, url, signal ? { signal } : undefined, company.name, observer);
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(`${company.name} job board returned HTTP ${response.status}`); }
  const body = await response.json();
  return company.ats === "greenhouse"
    ? (body as { jobs: GreenhouseJob[] }).jobs.map((job) => normalizeGreenhouse(company, job))
    : company.ats === "lever"
      ? (body as LeverJob[]).map((job) => normalizeLever(company, job))
      : company.ats === "ashby"
        ? (body as { jobs: AshbyJob[] }).jobs.map((job) => normalizeAshby(company, job))
        : (body as { offers: RecruiteeJob[] }).offers.map((job) => normalizeRecruitee(company, job));
}

async function fetchWorkdayJobs(company: Company, fetcher: Fetch, signal?: AbortSignal, observer?: FetchJobsObserver): Promise<Job[]> {
  const source = parseWorkdayToken(company.token);
  const endpoint = `https://${source.host}/wday/cxs/${encodeURIComponent(source.tenant)}/${encodeURIComponent(source.site)}/jobs`;
  const limit = 20;
  const pageDelayMs = Math.max(0, Math.trunc(observer?.workdayPageDelayMs ?? 0));
  const pacingNow = observer?.pacingNow ?? Date.now;
  const pacingSleep = observer?.pacingSleep ?? abortableDelay;
  let previousPageStart: number | undefined;
  let pageGate = Promise.resolve();
  async function pacePageStart() {
    if (!pageDelayMs) return;
    let release!: () => void;
    const previous = pageGate;
    pageGate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const remaining = previousPageStart === undefined ? 0 : previousPageStart + pageDelayMs - pacingNow();
      if (remaining > 0) await pacingSleep(remaining, signal);
      previousPageStart = pacingNow();
    } finally { release(); }
  }
  async function page(offset: number): Promise<{ total: number; jobs: WorkdayJob[] }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await pacePageStart();
      const response = await fetcher(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText: "" }), signal });
      if (response.ok) {
        const body = await response.json() as { total?: unknown; jobPostings?: unknown };
        if (!Number.isInteger(body.total) || !Array.isArray(body.jobPostings)) throw new Error(`${company.name} Workday source returned an invalid payload`);
        return { total: body.total as number, jobs: body.jobPostings as WorkdayJob[] };
      }
      if (!isTransientStatus(response.status) || attempt === 2) { await response.body?.cancel().catch(() => undefined); throw new Error(`${company.name} job board returned HTTP ${response.status}`); }
      const delayMs = retryDelayMs(response, attempt);
      observer?.onBackoff?.({ status: response.status, delayMs });
      await response.body?.cancel().catch(() => undefined);
      await abortableDelay(delayMs, signal);
    }
    throw new Error(`${company.name} Workday source exhausted retries`);
  }
  const first = await page(0);
  if (first.total < first.jobs.length || first.total > 100_000) throw new Error(`${company.name} Workday source reported an invalid total`);
  const offsets = Array.from({ length: Math.ceil(first.total / limit) - 1 }, (_, index) => (index + 1) * limit);
  const pages = new Array<WorkdayJob[]>(offsets.length);
  let cursor = 0;
  async function worker() {
    while (cursor < offsets.length) {
      const index = cursor++;
      const offset = offsets[index]!;
      const result = await page(offset);
      if (result.jobs.length === 0 && offset < first.total) throw new Error(`${company.name} Workday source truncated at offset ${offset} of ${first.total}`);
      pages[index] = result.jobs;
    }
  }
  const workerCount = pageDelayMs > 0 ? 1 : Math.min(4, offsets.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  const jobs = [first.jobs, ...pages].flat().slice(0, first.total);
  if (jobs.length !== first.total) throw new Error(`${company.name} Workday source returned ${jobs.length} of ${first.total} jobs`);
  return jobs.map((job) => normalizeWorkday(company, source, job));
}

async function fetchWithRetry(fetcher: Fetch, input: string | URL, init: RequestInit | undefined, companyName: string, observer?: FetchJobsObserver): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetcher(input, init);
    if (response.ok || !isTransientStatus(response.status)) return response;
    if (attempt === 2) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${companyName} job board returned HTTP ${response.status}`);
    }
    const delayMs = retryDelayMs(response, attempt);
    observer?.onBackoff?.({ status: response.status, delayMs });
    await response.body?.cancel().catch(() => undefined);
    await abortableDelay(delayMs, init?.signal ?? undefined);
  }
  throw new Error(`${companyName} job source exhausted retries`);
}

export function isTransientStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504 || status === 520;
}

export function retryDelayMs(response: Response, attempt: number): number {
  const value = response.headers.get("retry-after");
  if (value !== null) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1_000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
  }
  return 500 * 2 ** attempt;
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!ms) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeWorkday(company: Company, source: ReturnType<typeof parseWorkdayToken>, job: WorkdayJob): Job {
  const location = job.locationsText ?? "Unspecified";
  const requisition = job.bulletFields?.[0] ?? job.externalPath.split("_").at(-1) ?? job.externalPath;
  return classifyJob({
    id: `workday:${company.slug}:${requisition}`,
    company: company.name,
    title: job.title,
    location,
    remote: /remote/i.test(location),
    workMode: /remote/i.test(location) ? "remote" : "unknown",
    eligibleCountries: [], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "unknown",
    url: `https://${source.host}/en-US/${source.site}${job.externalPath}`,
    description: "",
  });
}

async function fetchWorkdayDescription(company: Company, jobUrl: string, fetcher: Fetch): Promise<string> {
  const source = parseWorkdayToken(company.token);
  const path = new URL(jobUrl).pathname.replace(new RegExp(`^/en-US/${escapeRegExp(source.site)}`), "");
  const response = await fetcher(`https://${source.host}/wday/cxs/${encodeURIComponent(source.tenant)}/${encodeURIComponent(source.site)}${path}`);
  if (!response.ok) throw new Error(`${company.name} job detail returned HTTP ${response.status}`);
  const body = await response.json() as { jobPostingInfo?: { jobDescription?: unknown } };
  if (typeof body.jobPostingInfo?.jobDescription !== "string") throw new Error(`${company.name} job detail returned an invalid payload`);
  return stripHtml(body.jobPostingInfo.jobDescription);
}

function parseWorkdayToken(token: string): { host: string; tenant: string; site: string } {
  const [host, tenant, site, ...rest] = token.split("/");
  if (!host || !tenant || !site || rest.length) throw new Error(`Invalid Workday source token: ${token}`);
  return { host, tenant, site };
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function normalizeAshby(company: Company, job: AshbyJob): Job {
  const location = job.location ?? "Unspecified";
  return classifyJob({
    id: `ashby:${company.slug}:${job.id}`,
    company: company.name,
    title: job.title,
    location,
    remote: job.isRemote ?? /remote/i.test(location),
    workMode: job.isRemote ? "remote" : "unknown",
    eligibleCountries: [],
    excludedCountries: [],
    eligibleRegions: [],
    eligibilityConfidence: "unknown",
    url: job.jobUrl,
    updatedAt: job.publishedAt,
    description: job.descriptionPlain ?? "",
  });
}

function normalizeLever(company: Company, job: LeverJob): Job {
  const location = job.categories?.location ?? "Unspecified";
  return classifyJob({
    id: `lever:${company.slug}:${job.id}`,
    company: company.name,
    title: job.text,
    location,
    remote: job.workplaceType === "remote" || /remote/i.test(location),
    workMode: job.workplaceType === "remote" ? "remote" : job.workplaceType === "hybrid" ? "hybrid" : job.workplaceType === "onsite" ? "onsite" : "unknown",
    eligibleCountries: [],
    excludedCountries: [],
    eligibleRegions: [],
    eligibilityConfidence: "unknown",
    url: job.hostedUrl,
    updatedAt: job.createdAt ? new Date(job.createdAt).toISOString() : undefined,
    description: job.descriptionPlain ?? "",
  });
}

function normalizeGreenhouse(company: Company, job: GreenhouseJob): Job {
  const location = job.location?.name ?? "Unspecified";
  return classifyJob({
    id: `greenhouse:${company.slug}:${job.id}`,
    company: company.name,
    title: job.title,
    location,
    remote: /remote/i.test(location),
    workMode: "unknown",
    eligibleCountries: [],
    excludedCountries: [],
    eligibleRegions: [],
    eligibilityConfidence: "unknown",
    url: job.absolute_url,
    updatedAt: job.updated_at,
    description: stripHtml(job.content ?? ""),
  });
}

function normalizeRecruitee(company: Company, job: RecruiteeJob): Job {
  const location = [job.city, job.state_name, job.country_code?.toUpperCase()].filter(Boolean).join(", ") || "Unspecified";
  const translation = job.translations?.en ?? Object.values(job.translations ?? {})[0];
  const description = [translation?.description ?? job.description, translation?.requirements ?? job.requirements].filter(Boolean).map((value) => stripHtml(value!)).join("\n\n");
  const updatedAt = job.updated_at ?? job.published_at;
  return classifyJob({
    id: `recruitee:${company.slug}:${job.guid}`,
    company: company.name,
    title: translation?.title ?? job.title,
    location,
    remote: job.remote === true,
    workMode: job.remote ? "remote" : job.hybrid ? "hybrid" : job.on_site ? "onsite" : "unknown",
    eligibleCountries: [], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "unknown",
    url: job.careers_url,
    ...(updatedAt ? { updatedAt: new Date(updatedAt).toISOString() } : {}),
    description,
  });
}

function matches(job: Job, query: SearchQuery): boolean {
  const terms = query.query?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const location = query.location ? normalizeLocation(query.location) : undefined;
  const searchable = `${job.title} ${job.company}`.toLocaleLowerCase();
  return (terms.length === 0 || terms.every((term) => searchable.includes(term)))
    && (!location || normalizeLocation(job.location).includes(location))
    && (!query.country || isEligibleForCountry(job, query.country))
    && (query.remote === undefined || job.remote === query.remote);
}

function toSummary(job: Job): JobSummary {
  const { description: _description, ...summary } = job;
  return summary;
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
