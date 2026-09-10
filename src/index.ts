import companyData from "../data/companies.json";
import { createCatalog } from "./catalog.ts";
import type { Ats, Company } from "./types.ts";

export const companies: Company[] = Object.entries(companyData).map(([slug, value]) => ({
  slug,
  name: value.name,
  ats: value.ats as Ats,
  token: value.token,
  cohorts: "cohorts" in value ? value.cohorts as string[] : undefined,
  companyDomain: "companyDomain" in value ? value.companyDomain as string : undefined,
  sourceUrl: "sourceUrl" in value ? value.sourceUrl as string : undefined,
  discoveredFrom: "discoveredFrom" in value ? value.discoveredFrom as Company["discoveredFrom"] : undefined,
  verification: "verification" in value ? value.verification as Company["verification"] : undefined,
  domainEvidence: "domainEvidence" in value ? value.domainEvidence as Company["domainEvidence"] : undefined,
}));

export const catalog = createCatalog({ companies });
export { createCatalog } from "./catalog.ts";
export type { Catalog } from "./catalog.ts";
export type { Ats, Company, CrawlReport, Job, JobPartition, JobSnapshot, JobSummary, SearchQuery } from "./types.ts";
export { createCrawlReporter, fetchSeedSnapshot, resolveAggregatorUrl } from "./crawl-reporting.ts";
export type { CrawlReportPayload } from "./crawl-reporting.ts";
export { parseCandidateProfile, ResumeInputError, validateCandidateProfileEvidence } from "./candidate-profile.ts";
export type { CandidateFact, CandidateFactKind, CandidateInference, CandidateProfile, EvidenceSpan, EvidenceValidationResult, NormalizedResume, ResumeFormat, ResumeInput } from "./candidate-profile.ts";
export { matchJobs } from "./job-matching.ts";
export type { CandidateIntent, FilteredJob, JobMatch, JobMatchingResult, RoleFamily, RoleFamilyExpansion, SupportedRequirement, TitleExpansion, TransferableRequirement } from "./job-matching.ts";
export { createJobRecommender, RecommendationError } from "./job-recommendations.ts";
export type { JobRecommenderOptions, RecommendJobsInput, RecommendJobsResult, RecommendationRefreshInput, RecommendationRefreshResult, RefreshPolicy } from "./job-recommendations.ts";
export { createJobFitAnalyzer, JobFitAnalysisError } from "./job-fit-analysis.ts";
export type { AnalyzeJobFitInput, AnalyzeJobFitResult, JobFitAnalyzerOptions, JobFitAssessment, JobFitReason, PartiallySupportedRequirement } from "./job-fit-analysis.ts";
export { createResumeOptimizer, ResumeOptimizationError } from "./resume-optimization.ts";
export type { OptimizeResumeInput, OptimizeResumeResult, ResumeOptimizationOutput, ResumeOptimizerOptions, ResumeSuggestion } from "./resume-optimization.ts";
export { createSelectedJobLookup } from "./selected-job-lookup.ts";
export type { SelectedJobLookupOptions } from "./selected-job-lookup.ts";
export { createJobCoverageReader, projectJobCoverage } from "./job-coverage.ts";
export type { CountryJobCoverage, JobCoverageSummary } from "./job-coverage.ts";
export { createHostedRuntime } from "./runtime.ts";
export type { SnapshotStore } from "./crawler.ts";
export { createToolHandler } from "./tools.ts";
export { createMcpHandler, FLOW_INSTRUCTIONS } from "./mcp.ts";
export type { UpdateNotice } from "./update-check.ts";
export { VERSION } from "./version.ts";
export { usageEventFor } from "./usage.ts";
export type { UsageEvent } from "./usage.ts";
