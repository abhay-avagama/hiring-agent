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
    const jobs = fetchBoard(company);
    cache.set(company.slug, { expiresAt: Date.now() + (options.cacheTtlMs ?? 5 * 60_000), jobs });
    try {
      return await jobs;
    } catch (error) {
      cache.delete(company.slug);
      throw error;
    }
  }

  async function fetchBoard(company: Company): Promise<Job[]> {
    const url = company.ats === "greenhouse"
      ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.token)}/jobs?content=true`
      : company.ats === "lever"
        ? `https://api.lever.co/v0/postings/${encodeURIComponent(company.token)}?mode=json`
        : `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company.token)}`;
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`${company.name} job board returned HTTP ${response.status}`);
    const body = await response.json();
    return company.ats === "greenhouse"
      ? (body as { jobs: GreenhouseJob[] }).jobs.map((job) => normalizeGreenhouse(company, job))
      : company.ats === "lever"
        ? (body as LeverJob[]).map((job) => normalizeLever(company, job))
        : (body as { jobs: AshbyJob[] }).jobs.map((job) => normalizeAshby(company, job));
  }

  return {
    async search(query) {
      const jobs = (await Promise.all(options.companies.map((company) => fetchJobs(company).catch(() => [])))).flat();

      return jobs.filter((job) => matches(job, query)).slice(0, query.limit ?? 50).map(toSummary);
    },
    async get(id) {
      const [ats, slug] = id.split(":", 3);
      const company = options.companies.find((candidate) => candidate.ats === ats && candidate.slug === slug);
      if (!company) return null;
      const job = (await fetchJobs(company)).find((candidate) => candidate.id === id) ?? null;
      if (job && !job.description.trim()) throw new Error(`Full description unavailable for job: ${id}`);
      return job;
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
  const terms = query.query?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const location = query.location ? normalizeLocation(query.location) : undefined;
  const searchable = `${job.title} ${job.company}`.toLocaleLowerCase();
  return (terms.length === 0 || terms.every((term) => searchable.includes(term)))
    && (!location || normalizeLocation(job.location).includes(location))
    && (!query.country || matchesCountry(job.location, query.country))
    && (query.remote === undefined || job.remote === query.remote);
}

function matchesCountry(location: string, country: "IN"): boolean {
  if (country !== "IN") return false;
  return /\b(india|bengaluru|bangalore|hyderabad|pune|chennai|mumbai|gurugram|gurgaon|noida|delhi|kolkata|ahmedabad|kochi|cochin|jaipur|chandigarh|coimbatore|indore|thiruvananthapuram|goa)\b/i.test(location);
}

function normalizeLocation(value: string): string {
  const aliases: Record<string, string> = {
    bangalore: "bengaluru",
    gurgaon: "gurugram",
    bombay: "mumbai",
    calcutta: "kolkata",
    madras: "chennai",
  };
  return value.trim().toLocaleLowerCase().replace(/\b(bangalore|gurgaon|bombay|calcutta|madras)\b/g, (name) => aliases[name] ?? name);
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
