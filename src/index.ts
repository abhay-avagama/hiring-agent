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
export type { Ats, Company, Job, JobSummary, SearchQuery } from "./types.ts";
export { parseCandidateProfile, ResumeInputError, validateCandidateProfileEvidence } from "./candidate-profile.ts";
export type { CandidateFact, CandidateFactKind, CandidateInference, CandidateProfile, EvidenceSpan, EvidenceValidationResult, NormalizedResume, ResumeFormat, ResumeInput } from "./candidate-profile.ts";
export { matchJobs } from "./job-matching.ts";
export type { CandidateIntent, FilteredJob, JobMatch, JobMatchingResult, SupportedRequirement, TransferableRequirement } from "./job-matching.ts";
