/** ATS boards plus "jobposting": a company's own career site read only through its schema.org JobPosting markup (token = careers URL). */
export const ALL_PROVIDERS = ["greenhouse", "lever", "ashby", "workday", "recruitee", "smartrecruiters", "workable", "breezy", "freshteam", "keka", "zohorecruit", "jobposting", "accenture", "infosys", "capgemini"] as const;
export type Ats = (typeof ALL_PROVIDERS)[number];

export interface DomainEvidence {
  kind: "authoritative_dataset" | "company_registry" | "company_redirect" | "company_page_link";
  reference: string;
}

export interface Company {
  slug: string;
  name: string;
  ats: Ats;
  token: string;
  cohorts?: string[];
  companyDomain?: string;
  sourceUrl?: string;
  discoveredFrom?: DiscoveryProvenance;
  verification?: SourceVerification;
  domainEvidence?: DomainEvidence;
}

export type DiscoveryChannel = "search" | "career_page" | "provider_directory" | "community" | "dataset" | "legacy";

export interface DiscoveryProvenance {
  channel: DiscoveryChannel;
  reference: string;
}

export interface SourceCandidate {
  slug?: string;
  companyName: string;
  companyDomain: string;
  sourceUrl: string;
  cohorts?: string[];
  discoveredFrom: DiscoveryProvenance;
  domainEvidence?: DomainEvidence;
}

export interface SourceVerification {
  checkedAt: string;
  canonicalSourceUrl: string;
  observedCompanyName: string;
  identityEvidence: "provider_company_name" | "provider_tenant" | "structured_domain_link" | "company_redirect" | "company_page_link" | "provider_board" | "company_site";
  contentType: string;
  payloadVersion: string;
  jobCount: number;
}

export interface VerifiedCompany extends Company {
  companyDomain: string;
  sourceUrl: string;
  discoveredFrom: DiscoveryProvenance;
  verification: SourceVerification;
}

export type SourceRejectionReason = "invalid_candidate" | "unsupported_source" | "duplicate_source" | "duplicate_company" | "duplicate_slug" | "unreachable" | "invalid_payload" | "empty_board" | "identity_mismatch" | "no_country_jobs";

export interface RejectedSource extends SourceCandidate {
  reason: SourceRejectionReason;
  detail: string;
}

export interface SourceVerificationResult {
  verified: VerifiedCompany[];
  rejected: RejectedSource[];
}

export type WorkMode = "remote" | "hybrid" | "onsite" | "unknown";
export type EligibilityConfidence = "explicit" | "inferred" | "unknown";

export interface JobSummary {
  id: string;
  company: string;
  title: string;
  location: string;
  remote: boolean;
  workMode: WorkMode;
  eligibleCountries: string[];
  excludedCountries: string[];
  eligibleRegions: string[];
  eligibilityConfidence: EligibilityConfidence;
  url: string;
  /** Posting date when the board exposes one (Workday's relative label is approximate), otherwise the board's last-update time. */
  updatedAt?: string;
  /** Days since the posting date at the time of the search; absent when the board gave no date. */
  postedDaysAgo?: number;
  /** new = 7 days or less, older = 8 to 30, stale = beyond 30, undated = no posting date. Present it as such; a stale listing may still be open. */
  age?: JobAge;
}

export type JobAge = "new" | "older" | "stale" | "undated";
/** The age windows a search or recommendation walked: 7 days, then 14, then 30, then everything, until at least CASCADE_MINIMUM results appeared. */
export interface SearchWindow { daysUsed: number; widened: boolean; steps: Array<{ days: number; results: number }> }
export const CASCADE_WINDOWS = [7, 14, 30, 0] as const;
export const CASCADE_MINIMUM = 5;

export interface Job extends JobSummary {
  description: string;
}

/** Partition lookup that ignores inherited properties, so a slug such as "constructor" never resolves to Object.prototype. */
export function partitionFor<T>(partitions: Record<string, T>, slug: string): T | undefined {
  return Object.hasOwn(partitions, slug) ? partitions[slug] : undefined;
}

export interface SearchQuery {
  query?: string;
  location?: string;
  country?: string;
  remote?: boolean;
  /** Only jobs posted within this many days. Unset walks 7, 14, 30, then everything until 5 results appear; an explicit value is a single window that drops undated jobs; 0 includes everything. */
  maxAgeDays?: number;
  limit?: number;
}

export interface CrawlFailure {
  source: string;
  error: string;
}

export interface CrawlReport {
  startedAt: string;
  finishedAt: string;
  considered?: number;
  selected: number;
  cached?: number;
  deferred?: number;
  succeeded: number;
  failed: CrawlFailure[];
  sources?: CrawlSourceResult[];
}

export interface CrawlSourceResult {
  source: string;
  status: "succeeded" | "failed";
  attempts: number;
  durationMs: number;
  jobs: number;
  countryJobs: Record<string, number>;
  throttles: number;
  backoffMs: number;
  error?: string;
}

export interface JobPartition {
  fetchedAt: string;
  jobs: Job[];
}

export interface JobSnapshot {
  version: 1;
  updatedAt: string;
  partitions: Record<string, JobPartition>;
  lastCrawl: CrawlReport;
}
