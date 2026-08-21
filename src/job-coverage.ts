import { isEligibleForCountry } from "./locations.ts";
import type { SnapshotStore } from "./crawler.ts";
import type { Company, JobSnapshot } from "./types.ts";

export interface CountryJobCoverage {
  country: string;
  indexedSourcesWithEligibleJobs: number;
  eligibleJobs: number;
  distinctEligibleEmployers: number;
}

export interface JobCoverageSummary {
  snapshotUpdatedAt: string;
  countries: CountryJobCoverage[];
}

export function createJobCoverageReader(options: { sources: Company[]; store: SnapshotStore }) {
  return {
    async getCoverage(value: unknown): Promise<JobCoverageSummary> {
      const countries = validateCoverageInput(value);
      const snapshot = await options.store.read();
      if (!snapshot) throw new Error("No local job snapshot is available");
      return projectJobCoverage(options.sources, snapshot, countries);
    },
  };
}

export function projectJobCoverage(sources: Company[], snapshot: JobSnapshot, countries: string[]): JobCoverageSummary {
  const normalizedCountries = [...new Set(countries.map(normalizeCountry))];
  const indexedSources = sources.flatMap((source) => {
    const partition = snapshot.partitions[source.slug];
    return partition ? [{ source, jobs: partition.jobs }] : [];
  });

  return {
    snapshotUpdatedAt: snapshot.updatedAt,
    countries: normalizedCountries.map((country) => {
      const eligibleSources = indexedSources.filter(({ jobs }) => jobs.some((job) => isEligibleForCountry(job, country)));
      return {
        country,
        indexedSourcesWithEligibleJobs: eligibleSources.length,
        eligibleJobs: eligibleSources.reduce((total, { jobs }) => total + jobs.filter((job) => isEligibleForCountry(job, country)).length, 0),
        distinctEligibleEmployers: new Set(eligibleSources.flatMap(({ source }) => source.companyDomain ? [normalizeDomain(source.companyDomain)] : [])).size,
      };
    }),
  };
}

function normalizeCountry(country: string): string {
  const normalized = country.toUpperCase();
  if (!/^[A-Z]{2}$/u.test(normalized)) throw new Error("Coverage requires two-letter country codes");
  return normalized;
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./u, "");
}

function validateCoverageInput(value: unknown): string[] {
  if (!isRecord(value)) throw new Error("Coverage input must be an object");
  const unknown = Object.keys(value).find((key) => key !== "countries");
  if (unknown) throw new Error(`get_job_coverage does not accept field: ${unknown}`);
  if (!Array.isArray(value.countries) || value.countries.length === 0) throw new Error("get_job_coverage requires at least one country");
  if (value.countries.length > 20) throw new Error("get_job_coverage accepts at most 20 countries");
  if (!value.countries.every((country) => typeof country === "string" && /^[a-z]{2}$/iu.test(country))) {
    throw new Error("countries must contain only two-letter country codes");
  }
  return value.countries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
