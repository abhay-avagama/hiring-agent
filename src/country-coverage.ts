import { readFile } from "node:fs/promises";
import { atomicJson } from "./atomic-file.ts";
import { deriveLeadState, readEnrichmentRegistry, type EnrichmentState } from "./enrichment-registry.ts";
import { isEligibleForCountry } from "./locations.ts";
import { stampReport, type ReportMeta } from "./report-meta.ts";
import { resolveSource } from "./source-verification.ts";
import { ALL_PROVIDERS } from "./types.ts";
import type { Ats, EligibilityConfidence, JobSnapshot, SourceCandidate, VerifiedCompany } from "./types.ts";
import { projectJobCoverage } from "./job-coverage.ts";

export interface CountryCoveragePaths {
  catalog: string;
  candidates: string;
  registry: string;
  snapshot: string;
  output?: string;
}

export interface CountryCoverageReport extends ReportMeta {
  country: string;
  catalog: {
    verifiedSources: number; countryCohortSources: number;
    providers: Partial<Record<Ats, number>>; countryCohortProviders: Partial<Record<Ats, number>>;
  };
  snapshot: {
    updatedAt: string; indexedSources: number; countryCohortIndexedSources: number; catalogCoveragePercent: number; orphanedSources: string[];
    snapshotJobs: number; indexedJobs: number; indexedSourcesWithEligibleJobs: number; eligibleJobs: number; distinctEligibleEmployers: number;
    indexedProviders: Partial<Record<Ats, number>>; countryCohortIndexedProviders: Partial<Record<Ats, number>>;
    allIndexedJobsByConfidence: Record<EligibilityConfidence, number>; eligibleJobsByConfidence: Record<EligibilityConfidence, number>;
  };
  sourceHealth: { latestBatch: { selected: number; succeeded: number; failed: number; successPercent: number | null } };
  freshness: {
    referenceAt: string; fresh24Hours: number; age1To7Days: number; age8To14Days: number; olderThan14Days: number;
    futureTimestamp: number; neverIndexedSources: string[]; oldestFetchedAt: string | null; newestFetchedAt: string | null;
    sources: { fresh24Hours: string[]; age1To7Days: string[]; age8To14Days: string[]; olderThan14Days: string[]; futureTimestamp: string[] };
  };
  discovery: {
    registryLeadsGlobal: number; registryStatesGlobal: Record<EnrichmentState, number>; verifiedRegistryLeadsGlobal: number; registryVerificationYieldPercentGlobal: number;
    candidatesGlobal: number; promotedCandidatesGlobal: number; candidatePromotionPercentGlobal: number;
    countryCohortCandidates: number; promotedCountryCohortCandidates: number; countryCohortCandidatePromotionPercent: number;
  };
}

export async function generateCountryCoverageReport(paths: CountryCoveragePaths, options: { country: string; asOf?: Date }): Promise<CountryCoverageReport> {
  const country = options.country.toUpperCase();
  if (!/^[A-Z]{2}$/u.test(country)) throw new Error("Country coverage requires a two-letter country code");
  const asOf = options.asOf ?? new Date();
  if (!Number.isFinite(asOf.getTime())) throw new Error("Country coverage requires a valid reference time");
  const [catalog, candidates, registry, snapshot] = await Promise.all([
    readCatalog(paths.catalog), readCandidates(paths.candidates), readEnrichmentRegistry(paths.registry), readSnapshot(paths.snapshot),
  ]);
  const slugs = Object.keys(catalog).sort();
  const countryCohortSlugs = slugs.filter((slug) => catalog[slug]!.cohorts?.includes(country));
  const providers = countProviders(slugs.map((slug) => catalog[slug]!.ats));
  const indexedSlugs = slugs.filter((slug) => snapshot.partitions[slug]);
  const countryCohortIndexedSlugs = countryCohortSlugs.filter((slug) => snapshot.partitions[slug]);
  const neverIndexedSources = slugs.filter((slug) => !snapshot.partitions[slug]);
  const orphanedSources = Object.keys(snapshot.partitions).filter((slug) => !catalog[slug]).sort();
  const indexedJobs = indexedSlugs.flatMap((slug) => snapshot.partitions[slug]!.jobs);
  const eligibleJobs = indexedJobs.filter((job) => isEligibleForCountry(job, country));
  const candidateCoverage = projectJobCoverage(slugs.map((slug) => ({ slug, ...catalog[slug]! })), snapshot, [country]).countries[0]!;
  const allConfidence = confidenceCounts(indexedJobs);
  const eligibleConfidence = confidenceCounts(eligibleJobs);
  const states = { unresolved: 0, matched: 0, evidence_ready: 0, verified: 0, rejected: 0 } satisfies Record<EnrichmentState, number>;
  for (const lead of registry.leads) states[deriveLeadState(lead)] += 1;
  const promotedCandidates = candidates.filter((candidate) => candidateIsPromoted(candidate, catalog)).length;
  const countryCandidates = candidates.filter((candidate) => candidate.cohorts?.includes(country));
  const promotedCountryCandidates = countryCandidates.filter((candidate) => candidateIsPromoted(candidate, catalog)).length;
  const selected = snapshot.lastCrawl.selected;
  const report = stampReport("country-coverage:1", 1, {
    country,
    catalog: {
      verifiedSources: slugs.length, countryCohortSources: countryCohortSlugs.length, providers,
      countryCohortProviders: countProviders(countryCohortSlugs.map((slug) => catalog[slug]!.ats)),
    },
    snapshot: {
      updatedAt: snapshot.updatedAt,
      indexedSources: indexedSlugs.length,
      countryCohortIndexedSources: countryCohortIndexedSlugs.length,
      catalogCoveragePercent: percent(indexedSlugs.length, slugs.length),
      orphanedSources,
      snapshotJobs: Object.values(snapshot.partitions).reduce((sum, partition) => sum + partition.jobs.length, 0),
      indexedJobs: indexedJobs.length,
      indexedSourcesWithEligibleJobs: candidateCoverage.indexedSourcesWithEligibleJobs,
      eligibleJobs: candidateCoverage.eligibleJobs,
      distinctEligibleEmployers: candidateCoverage.distinctEligibleEmployers,
      indexedProviders: countProviders(indexedSlugs.map((slug) => catalog[slug]!.ats)),
      countryCohortIndexedProviders: countProviders(countryCohortIndexedSlugs.map((slug) => catalog[slug]!.ats)),
      allIndexedJobsByConfidence: allConfidence,
      eligibleJobsByConfidence: eligibleConfidence,
    },
    sourceHealth: { latestBatch: {
      selected, succeeded: snapshot.lastCrawl.succeeded, failed: snapshot.lastCrawl.failed.length,
      successPercent: selected > 0 ? percent(snapshot.lastCrawl.succeeded, selected) : null,
    } },
    freshness: freshness(indexedSlugs.map((slug) => [slug, snapshot.partitions[slug]!.fetchedAt] as const), neverIndexedSources, asOf),
    discovery: {
      registryLeadsGlobal: registry.leads.length, registryStatesGlobal: states, verifiedRegistryLeadsGlobal: states.verified,
      registryVerificationYieldPercentGlobal: percent(states.verified, registry.leads.length),
      candidatesGlobal: candidates.length, promotedCandidatesGlobal: promotedCandidates,
      candidatePromotionPercentGlobal: percent(promotedCandidates, candidates.length),
      countryCohortCandidates: countryCandidates.length, promotedCountryCohortCandidates: promotedCountryCandidates,
      countryCohortCandidatePromotionPercent: percent(promotedCountryCandidates, countryCandidates.length),
    },
  }, asOf);
  if (paths.output) await atomicJson(paths.output, report);
  return report;
}

async function readCatalog(path: string): Promise<Record<string, Omit<VerifiedCompany, "slug">>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value)) throw new Error(`Invalid verified catalog: ${path}`);
  for (const [slug, company] of Object.entries(value)) {
    if (!isRecord(company) || !(ALL_PROVIDERS as readonly string[]).includes(String(company.ats)) || typeof company.token !== "string"
      || (typeof company.companyDomain !== "string" && !(isRecord(company.verification) && company.verification.identityEvidence === "provider_board")) || typeof company.sourceUrl !== "string"
      || company.cohorts !== undefined && (!Array.isArray(company.cohorts) || !company.cohorts.every(validCountryCode))
      || !validVerification(company.verification)) throw new Error(`Invalid verified catalog source: ${slug}`);
  }
  return value as Record<string, Omit<VerifiedCompany, "slug">>;
}

async function readCandidates(path: string): Promise<SourceCandidate[]> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(value) || !value.every((candidate) => isRecord(candidate) && typeof candidate.companyName === "string"
    && typeof candidate.companyDomain === "string" && typeof candidate.sourceUrl === "string" && isRecord(candidate.discoveredFrom)
    && (candidate.cohorts === undefined || Array.isArray(candidate.cohorts) && candidate.cohorts.every((country) => typeof country === "string")))) throw new Error(`Invalid source candidates: ${path}`);
  return value as SourceCandidate[];
}

async function readSnapshot(path: string): Promise<JobSnapshot> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value) || value.version !== 1 || !validDate(value.updatedAt) || !isRecord(value.partitions) || !isRecord(value.lastCrawl)
    || !Object.values(value.partitions).every(validPartition) || !validLastCrawl(value.lastCrawl)) throw new Error(`Invalid job snapshot: ${path}`);
  return value as unknown as JobSnapshot;
}

function candidateIsPromoted(candidate: SourceCandidate, catalog: Record<string, Omit<VerifiedCompany, "slug">>): boolean {
  const source = resolveSource(candidate.sourceUrl);
  if (!source) return false;
  return Object.values(catalog).some((company) => company.ats === source.ats && company.token.toLowerCase() === source.token.toLowerCase()
    && company.companyDomain.toLowerCase() === candidate.companyDomain.toLowerCase());
}

function countProviders(values: Ats[]): Partial<Record<Ats, number>> {
  const counts: Partial<Record<Ats, number>> = {};
  for (const provider of [...values].sort()) counts[provider] = (counts[provider] ?? 0) + 1;
  return counts;
}

function freshness(values: ReadonlyArray<readonly [string, string]>, neverIndexedSources: string[], asOf: Date): CountryCoverageReport["freshness"] {
  const result: CountryCoverageReport["freshness"] = {
    referenceAt: asOf.toISOString(), fresh24Hours: 0, age1To7Days: 0, age8To14Days: 0, olderThan14Days: 0,
    futureTimestamp: 0, neverIndexedSources, oldestFetchedAt: null, newestFetchedAt: null,
    sources: { fresh24Hours: [], age1To7Days: [], age8To14Days: [], olderThan14Days: [], futureTimestamp: [] },
  };
  const valid: number[] = [];
  for (const [slug, value] of values) {
    const timestamp = Date.parse(value);
    valid.push(timestamp);
    const ageMs = asOf.getTime() - timestamp;
    if (ageMs < 0) { result.futureTimestamp += 1; result.sources.futureTimestamp.push(slug); }
    else if (ageMs <= 86_400_000) { result.fresh24Hours += 1; result.sources.fresh24Hours.push(slug); }
    else if (ageMs <= 7 * 86_400_000) { result.age1To7Days += 1; result.sources.age1To7Days.push(slug); }
    else if (ageMs <= 14 * 86_400_000) { result.age8To14Days += 1; result.sources.age8To14Days.push(slug); }
    else { result.olderThan14Days += 1; result.sources.olderThan14Days.push(slug); }
  }
  if (valid.length) {
    result.oldestFetchedAt = new Date(Math.min(...valid)).toISOString();
    result.newestFetchedAt = new Date(Math.max(...valid)).toISOString();
  }
  return result;
}

function confidenceCounts(jobs: JobSnapshot["partitions"][string]["jobs"]): Record<EligibilityConfidence, number> {
  const counts = { explicit: 0, inferred: 0, unknown: 0 } satisfies Record<EligibilityConfidence, number>;
  for (const job of jobs) counts[job.eligibilityConfidence] += 1;
  return counts;
}

function validPartition(value: unknown): boolean { return isRecord(value) && validDate(value.fetchedAt) && Array.isArray(value.jobs) && value.jobs.every(validJob); }
function validJob(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && typeof value.company === "string"
    && (typeof value.title === "string" || value.title === undefined)
    && typeof value.location === "string" && typeof value.remote === "boolean" && ["remote", "hybrid", "onsite", "unknown"].includes(String(value.workMode))
    && arrayOfStrings(value.eligibleCountries) && arrayOfStrings(value.excludedCountries) && arrayOfStrings(value.eligibleRegions)
    && ["explicit", "inferred", "unknown"].includes(String(value.eligibilityConfidence)) && typeof value.url === "string" && typeof value.description === "string";
}
function validLastCrawl(value: Record<string, unknown>): boolean {
  if (!validDate(value.startedAt) || !validDate(value.finishedAt) || !nonNegativeInteger(value.selected) || !nonNegativeInteger(value.succeeded)
    || !Array.isArray(value.failed) || !value.failed.every((failure) => isRecord(failure) && typeof failure.source === "string" && typeof failure.error === "string")) return false;
  return value.succeeded + value.failed.length <= value.selected;
}
function validVerification(value: unknown): boolean {
  return isRecord(value) && validDate(value.checkedAt) && typeof value.canonicalSourceUrl === "string" && typeof value.observedCompanyName === "string"
    && ["provider_company_name", "provider_tenant", "structured_domain_link", "company_redirect"].includes(String(value.identityEvidence))
    && typeof value.contentType === "string" && typeof value.payloadVersion === "string" && nonNegativeInteger(value.jobCount);
}
function validDate(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function validCountryCode(value: unknown): value is string { return typeof value === "string" && /^[A-Z]{2}$/u.test(value); }
function arrayOfStrings(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function nonNegativeInteger(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 0; }

function percent(numerator: number, denominator: number): number { return denominator > 0 ? Math.round(numerator / denominator * 10_000) / 100 : 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
