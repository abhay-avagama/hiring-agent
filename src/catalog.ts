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

export async function fetchSourceJobs(company: Company, fetcher: Fetch = globalThis.fetch, signal?: AbortSignal): Promise<Job[]> {
  if (company.ats === "workday") return fetchWorkdayJobs(company, fetcher, signal);
  const url = company.ats === "greenhouse"
    ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.token)}/jobs?content=true`
    : company.ats === "lever"
      ? `https://api.lever.co/v0/postings/${encodeURIComponent(company.token)}?mode=json`
      : `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company.token)}`;
  const response = await fetcher(url, signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`${company.name} job board returned HTTP ${response.status}`);
  const body = await response.json();
  return company.ats === "greenhouse"
    ? (body as { jobs: GreenhouseJob[] }).jobs.map((job) => normalizeGreenhouse(company, job))
    : company.ats === "lever"
      ? (body as LeverJob[]).map((job) => normalizeLever(company, job))
      : (body as { jobs: AshbyJob[] }).jobs.map((job) => normalizeAshby(company, job));
}

async function fetchWorkdayJobs(company: Company, fetcher: Fetch, signal?: AbortSignal): Promise<Job[]> {
  const source = parseWorkdayToken(company.token);
  const endpoint = `https://${source.host}/wday/cxs/${encodeURIComponent(source.tenant)}/${encodeURIComponent(source.site)}/jobs`;
  const limit = 20;
  async function page(offset: number): Promise<{ total: number; jobs: WorkdayJob[] }> {
    const response = await fetcher(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText: "" }), signal });
    if (!response.ok) throw new Error(`${company.name} job board returned HTTP ${response.status}`);
    const body = await response.json() as { total?: unknown; jobPostings?: unknown };
    if (!Number.isInteger(body.total) || !Array.isArray(body.jobPostings)) throw new Error(`${company.name} Workday source returned an invalid payload`);
    return { total: body.total as number, jobs: body.jobPostings as WorkdayJob[] };
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
  await Promise.all(Array.from({ length: Math.min(8, offsets.length) }, worker));
  const jobs = [first.jobs, ...pages].flat().slice(0, first.total);
  if (jobs.length !== first.total) throw new Error(`${company.name} Workday source returned ${jobs.length} of ${first.total} jobs`);
  return jobs.map((job) => normalizeWorkday(company, source, job));
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
