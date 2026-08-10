export type Ats = "greenhouse" | "lever" | "ashby";

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
}

export interface SourceVerification {
  checkedAt: string;
  canonicalSourceUrl: string;
  observedCompanyName: string;
  identityEvidence: "provider_company_name" | "structured_domain_link";
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

export type SourceRejectionReason = "invalid_candidate" | "unsupported_source" | "duplicate_source" | "duplicate_company" | "duplicate_slug" | "unreachable" | "invalid_payload" | "empty_board" | "identity_mismatch";

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
  updatedAt?: string;
}

export interface Job extends JobSummary {
  description: string;
}

export interface SearchQuery {
  query?: string;
  location?: string;
  country?: string;
  remote?: boolean;
  limit?: number;
}

export interface CrawlFailure {
  source: string;
  error: string;
}

export interface CrawlReport {
  startedAt: string;
  finishedAt: string;
  selected: number;
  succeeded: number;
  failed: CrawlFailure[];
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
