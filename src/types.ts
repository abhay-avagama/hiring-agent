export type Ats = "greenhouse" | "lever" | "ashby";

export interface Company {
  slug: string;
  name: string;
  ats: Ats;
  token: string;
  cohorts?: string[];
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
