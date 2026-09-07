import { classifyJob } from "./locations.ts";
import type { Ats, Company, Job } from "./types.ts";

/**
 * Table-driven adapters for providers added after the original five. Each entry knows how to recognise a board URL,
 * where its public structured endpoint lives, how to read the payload, and how to turn one record into a Job.
 * The original providers keep their hand-written paths; new ones only need a row here.
 */

type Rec = Record<string, unknown>;
/** Fetches a URL and returns its parsed JSON body; the caller supplies retry and pacing. */
export type JsonGet = (url: string) => Promise<unknown>;

export interface ProviderSpec {
  ats: Ats;
  label: string;
  /** Registrable host suffixes on which this provider serves boards and job pages. */
  hosts: string[];
  /** Common Crawl URL patterns that surface this provider's boards. */
  crawlPatterns: string[];
  resolve(url: URL): string | null;
  canonicalUrl(token: string): string;
  endpoint(token: string): string;
  jobsFromBody(body: unknown): Rec[] | null;
  providerName(jobs: Rec[], body: unknown): string;
  payloadVersion(body: unknown): string;
  normalize(company: Company, job: Rec): Job;
  /** Fetches every record when the endpoint paginates. Defaults to one request to `endpoint`. */
  fetchAll?(token: string, get: JsonGet): Promise<Rec[]>;
  /** Fetches the full description for one job when the listing omits it. */
  detail?(company: Company, job: Job, get: JsonGet): Promise<string>;
}

const PAGE = 100;
const MAX_RECORDS = 2000;

const smartrecruiters: ProviderSpec = {
  ats: "smartrecruiters",
  label: "SmartRecruiters",
  hosts: ["smartrecruiters.com"],
  crawlPatterns: ["jobs.smartrecruiters.com/*", "careers.smartrecruiters.com/*"],
  resolve(url) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "jobs.smartrecruiters.com" || url.hostname === "careers.smartrecruiters.com") return validToken(parts[0]);
    if (url.hostname === "api.smartrecruiters.com" && parts[0] === "v1" && parts[1] === "companies") return validToken(parts[2]);
    return null;
  },
  canonicalUrl: (token) => `https://jobs.smartrecruiters.com/${token}`,
  endpoint: (token) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=${PAGE}&offset=0`,
  jobsFromBody: (body) => (isRecord(body) ? asRecords(body.content) : null),
  providerName: (jobs) => majority(jobs.map((job) => (isRecord(job.company) ? str(job.company.name) : ""))),
  payloadVersion: () => "smartrecruiters-postings:v1",
  async fetchAll(token, get) {
    const records: Rec[] = [];
    for (let offset = 0; offset < MAX_RECORDS; offset += PAGE) {
      const body = await get(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=${PAGE}&offset=${offset}`);
      const page = smartrecruiters.jobsFromBody(body);
      if (!page) throw new Error("SmartRecruiters returned an invalid postings payload");
      records.push(...page);
      const total = isRecord(body) && typeof body.totalFound === "number" ? body.totalFound : records.length;
      if (page.length < PAGE || records.length >= total) break;
    }
    return records;
  },
  normalize(company, job) {
    const loc = isRecord(job.location) ? job.location : {};
    const country = str(loc.country);
    const location = str(loc.fullLocation) || [str(loc.city), str(loc.region), countryLabel(country)].filter(Boolean).join(", ") || "Unspecified";
    const remote = loc.remote === true;
    return classifyJob({
      id: `smartrecruiters:${company.slug}:${str(job.id)}`, company: company.name, title: str(job.name), location,
      remote, workMode: remote ? "remote" : loc.hybrid === true ? "hybrid" : "unknown",
      eligibleCountries: [], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "unknown",
      url: `https://jobs.smartrecruiters.com/${company.token}/${encodeURIComponent(str(job.id))}`, updatedAt: str(job.releasedDate) || undefined, description: "",
    });
  },
  async detail(company, job, get) {
    const id = job.id.split(":")[2] ?? "";
    const body = await get(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company.token)}/postings/${encodeURIComponent(id)}`);
    const sections = isRecord(body) && isRecord(body.jobAd) && isRecord(body.jobAd.sections) ? body.jobAd.sections : {};
    return ["jobDescription", "qualifications", "additionalInformation"].map((key) => { const section = sections[key]; return isRecord(section) ? plainText(str(section.text)) : ""; }).filter(Boolean).join("\n\n");
  },
};

const workable: ProviderSpec = {
  ats: "workable",
  label: "Workable",
  hosts: ["workable.com"],
  crawlPatterns: ["apply.workable.com/*"],
  resolve(url) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "apply.workable.com") return parts[0] && !["j", "api", "jobs", "embed", "assets"].includes(parts[0]) ? validToken(parts[0]) : null;
    const match = /^([a-z0-9-]+)\.workable\.com$/i.exec(url.hostname);
    if (match && !["www", "apply", "help", "resources", "jobs", "careers", "api", "app", "assets", "cdn", "status", "developers", "blog", "partners"].includes(match[1]!.toLowerCase())) return match[1]!.toLowerCase();
    return null;
  },
  canonicalUrl: (token) => `https://apply.workable.com/${token}/`,
  endpoint: (token) => `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}`,
  jobsFromBody: (body) => (isRecord(body) ? asRecords(body.jobs) : null),
  providerName: (_jobs, body) => (isRecord(body) ? str(body.name) : ""),
  payloadVersion: () => "workable-widget:v1",
  normalize(company, job) {
    const first = asRecords(job.locations)?.[0];
    const location = [str(job.city), str(job.state), str(job.country) || (first ? str(first.country) : "")].filter(Boolean).join(", ") || "Unspecified";
    const remote = job.telecommuting === true;
    return classifyJob({
      id: `workable:${company.slug}:${str(job.shortcode)}`, company: company.name, title: str(job.title), location,
      remote, workMode: remote ? "remote" : "unknown",
      eligibleCountries: [], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "unknown",
      url: str(job.url) || `https://apply.workable.com/j/${encodeURIComponent(str(job.shortcode))}`, updatedAt: str(job.published_on) || undefined, description: "",
    });
  },
  async detail(company, job, get) {
    const shortcode = job.id.split(":")[2] ?? "";
    const body = await get(`https://apply.workable.com/api/v2/accounts/${encodeURIComponent(company.token)}/jobs/${encodeURIComponent(shortcode)}`);
    if (!isRecord(body)) return "";
    return ["description", "requirements", "benefits"].map((key) => plainText(str(body[key]))).filter(Boolean).join("\n\n");
  },
};

const breezy: ProviderSpec = {
  ats: "breezy",
  label: "Breezy",
  hosts: ["breezy.hr"],
  crawlPatterns: ["*.breezy.hr/*"],
  resolve(url) {
    const match = /^([a-z0-9-]+)\.breezy\.hr$/i.exec(url.hostname);
    return match && !["www", "app", "api", "help", "blog"].includes(match[1]!.toLowerCase()) ? match[1]!.toLowerCase() : null;
  },
  canonicalUrl: (token) => `https://${token}.breezy.hr`,
  endpoint: (token) => `https://${token}.breezy.hr/json?verbose=true`,
  jobsFromBody: (body) => asRecords(body),
  providerName: (jobs) => majority(jobs.map((job) => (isRecord(job.company) ? str(job.company.name) : ""))),
  payloadVersion: () => "breezy-positions:v1",
  normalize(company, job) {
    const loc = isRecord(job.location) ? job.location : {};
    const location = str(loc.name) || [str(loc.city), isRecord(loc.state) ? str(loc.state.name) : "", isRecord(loc.country) ? str(loc.country.name) : ""].filter(Boolean).join(", ") || "Unspecified";
    const remote = loc.is_remote === true;
    return classifyJob({
      id: `breezy:${company.slug}:${str(job.id)}`, company: company.name, title: str(job.name), location,
      remote, workMode: remote ? "remote" : "unknown",
      eligibleCountries: [], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "unknown",
      url: str(job.url) || `https://${company.token}.breezy.hr/p/${encodeURIComponent(str(job.friendly_id) || str(job.id))}`, updatedAt: str(job.published_date) || undefined, description: plainText(str(job.description)),
    });
  },
};

const freshteam: ProviderSpec = {
  ats: "freshteam",
  label: "Freshteam",
  hosts: ["freshteam.com"],
  crawlPatterns: ["*.freshteam.com/jobs*"],
  resolve(url) {
    const match = /^([a-z0-9-]+)\.freshteam\.com$/i.exec(url.hostname);
    return match && !["www", "app", "api", "support", "help", "blog"].includes(match[1]!.toLowerCase()) ? match[1]!.toLowerCase() : null;
  },
  canonicalUrl: (token) => `https://${token}.freshteam.com/jobs`,
  endpoint: (token) => `https://${token}.freshteam.com/hire/widgets/jobs.json`,
  jobsFromBody(body) {
    if (!isRecord(body)) return null;
    const jobs = asRecords(body.jobs);
    if (!jobs) return null;
    const branches = new Map((asRecords(body.branches) ?? []).map((branch) => [String(branch.id), branch]));
    // The widget lists branches separately; pin each job's branch onto the record so normalize() sees it.
    return jobs.filter((job) => job.deleted !== true).map((job) => ({ ...job, branch: branches.get(String(job.branch_id)) }));
  },
  providerName: () => "",
  payloadVersion: () => "freshteam-widget:v1",
  normalize(company, job) {
    const branch = isRecord(job.branch) ? job.branch : {};
    const location = [str(branch.city), str(branch.state), countryLabel(str(branch.country_code))].filter(Boolean).join(", ") || (job.remote === true ? "Remote" : "Unspecified");
    const remote = job.remote === true;
    return classifyJob({
      id: `freshteam:${company.slug}:${str(job.unique_id) || str(job.id)}`, company: company.name, title: str(job.title), location,
      remote, workMode: remote ? "remote" : "unknown",
      eligibleCountries: [], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "unknown",
      url: `https://${company.token}.freshteam.com/jobs/${encodeURIComponent(str(job.unique_id) || str(job.id))}`, updatedAt: str(job.created_at) || undefined, description: plainText(str(job.description)),
    });
  },
};

export const PROVIDERS: ReadonlyArray<ProviderSpec> = [smartrecruiters, workable, breezy, freshteam];

export function providerSpec(ats: string): ProviderSpec | undefined {
  return PROVIDERS.find((spec) => spec.ats === ats);
}

/** Resolves a URL against the table-driven providers; returns null when none claims it. */
export function resolveProviderSource(value: string): { ats: Ats; token: string; canonicalSourceUrl: string; structuredEndpoint: string } | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  for (const spec of PROVIDERS) {
    const token = spec.resolve(url);
    if (token) return { ats: spec.ats, token, canonicalSourceUrl: spec.canonicalUrl(token), structuredEndpoint: spec.endpoint(token) };
  }
  return null;
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
/** ISO code to English name (US -> United States); anything that is not a two-letter code passes through. */
export function countryLabel(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return value.trim();
  try { const name = regionNames.of(code); return name && name !== code ? name : value.trim(); } catch { return value.trim(); }
}

function validToken(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : null;
}

export function plainText(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(p|li|div|h[1-6])>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function majority(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}
function str(value: unknown): string { return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : ""; }
function asRecords(value: unknown): Rec[] | null { return Array.isArray(value) && value.every(isRecord) ? value : null; }
function isRecord(value: unknown): value is Rec { return typeof value === "object" && value !== null && !Array.isArray(value); }
