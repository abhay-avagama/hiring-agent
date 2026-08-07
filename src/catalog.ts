import type { Company, Job, JobSummary, SearchQuery } from "./types.ts";

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

export function createCatalog(options: CatalogOptions): Catalog {
  const fetcher = options.fetch ?? globalThis.fetch;
  const cache = new Map<string, { expiresAt: number; jobs: Promise<Job[]> }>();

  async function fetchJobs(company: Company): Promise<Job[]> {
    const cached = cache.get(company.slug);
    if (cached && cached.expiresAt > Date.now()) return cached.jobs;
    const jobs = fetchBoard(company).catch(() => []);
    cache.set(company.slug, { expiresAt: Date.now() + (options.cacheTtlMs ?? 5 * 60_000), jobs });
    return jobs;
  }

  async function fetchBoard(company: Company): Promise<Job[]> {
    const url = company.ats === "greenhouse"
      ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.token)}/jobs?content=true`
      : company.ats === "lever"
        ? `https://api.lever.co/v0/postings/${encodeURIComponent(company.token)}?mode=json`
        : `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company.token)}`;
    const response = await fetcher(url, company.ats === "ashby" ? { method: "POST" } : undefined);
    if (!response.ok) return [];
    const body = await response.json();
    return company.ats === "greenhouse"
      ? (body as { jobs: GreenhouseJob[] }).jobs.map((job) => normalizeGreenhouse(company, job))
      : company.ats === "lever"
        ? (body as LeverJob[]).map((job) => normalizeLever(company, job))
        : (body as { jobs: AshbyJob[] }).jobs.map((job) => normalizeAshby(company, job));
  }

  return {
    async search(query) {
      const jobs = (await Promise.all(options.companies.map(fetchJobs))).flat();

      return jobs.filter((job) => matches(job, query)).slice(0, query.limit ?? 50);
    },
    async get(id) {
      const [ats, slug] = id.split(":", 3);
      const company = options.companies.find((candidate) => candidate.ats === ats && candidate.slug === slug);
      if (!company) return null;
      return (await fetchJobs(company)).find((job) => job.id === id) ?? null;
    },
  };
}

function normalizeAshby(company: Company, job: AshbyJob): Job {
  const location = job.location ?? "Unspecified";
  return {
    id: `ashby:${company.slug}:${job.id}`,
    company: company.name,
    title: job.title,
    location,
    remote: job.isRemote ?? /remote/i.test(location),
    url: job.jobUrl,
    updatedAt: job.publishedAt,
    description: job.descriptionPlain ?? "",
  };
}

function normalizeLever(company: Company, job: LeverJob): Job {
  const location = job.categories?.location ?? "Unspecified";
  return {
    id: `lever:${company.slug}:${job.id}`,
    company: company.name,
    title: job.text,
    location,
    remote: job.workplaceType === "remote" || /remote/i.test(location),
    url: job.hostedUrl,
    updatedAt: job.createdAt ? new Date(job.createdAt).toISOString() : undefined,
    description: job.descriptionPlain ?? "",
  };
}

function normalizeGreenhouse(company: Company, job: GreenhouseJob): Job {
  const location = job.location?.name ?? "Unspecified";
  return {
    id: `greenhouse:${company.slug}:${job.id}`,
    company: company.name,
    title: job.title,
    location,
    remote: /remote/i.test(location),
    url: job.absolute_url,
    updatedAt: job.updated_at,
    description: stripHtml(job.content ?? ""),
  };
}

function matches(job: JobSummary, query: SearchQuery): boolean {
  const needle = query.query?.trim().toLocaleLowerCase();
  const location = query.location?.trim().toLocaleLowerCase();
  return (!needle || `${job.title} ${job.company}`.toLocaleLowerCase().includes(needle))
    && (!location || job.location.toLocaleLowerCase().includes(location))
    && (query.remote === undefined || job.remote === query.remote);
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
