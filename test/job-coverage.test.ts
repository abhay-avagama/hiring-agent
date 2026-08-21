import { expect, test } from "bun:test";
import { createJobCoverageReader, projectJobCoverage } from "../src/job-coverage.ts";
import type { Company, Job, JobSnapshot } from "../src/types.ts";

const companies: Company[] = [
  { slug: "acme", name: "Acme", ats: "greenhouse", token: "acme", companyDomain: "acme.test", cohorts: ["US"] },
  { slug: "acme-secondary", name: "Acme", ats: "lever", token: "acme", companyDomain: "acme.test", cohorts: ["IN"] },
  { slug: "beta", name: "Beta", ats: "workday", token: "beta", companyDomain: "beta.test", cohorts: ["IN"] },
];

test("projects honest job-level country coverage without counting cohorts or orphaned partitions", () => {
  const snapshot: JobSnapshot = {
    version: 1,
    updatedAt: "2026-08-21T00:00:00.000Z",
    partitions: {
      acme: { fetchedAt: "2026-08-21T00:00:00.000Z", jobs: [job("acme-in", ["IN"]), job("acme-us", ["US"])] },
      "acme-secondary": { fetchedAt: "2026-08-21T00:00:00.000Z", jobs: [job("acme-in-2", ["IN"])] },
      beta: { fetchedAt: "2026-08-21T00:00:00.000Z", jobs: [job("beta-us", ["US"])] },
      orphan: { fetchedAt: "2026-08-21T00:00:00.000Z", jobs: [job("orphan-in", ["IN"])] },
    },
    lastCrawl: { startedAt: "2026-08-21T00:00:00.000Z", finishedAt: "2026-08-21T00:01:00.000Z", selected: 3, succeeded: 3, failed: [] },
  };

  expect(projectJobCoverage(companies, snapshot, ["in", "US"])).toEqual({
    snapshotUpdatedAt: "2026-08-21T00:00:00.000Z",
    countries: [
      { country: "IN", indexedSourcesWithEligibleJobs: 2, eligibleJobs: 2, distinctEligibleEmployers: 1 },
      { country: "US", indexedSourcesWithEligibleJobs: 2, eligibleJobs: 2, distinctEligibleEmployers: 2 },
    ],
  });
});

test("reads coverage before resume collection and validates its closed input", async () => {
  const snapshot: JobSnapshot = {
    version: 1, updatedAt: "2026-08-21T00:00:00.000Z",
    partitions: { acme: { fetchedAt: "2026-08-21T00:00:00.000Z", jobs: [job("acme-in", ["IN"])] } },
    lastCrawl: { startedAt: "2026-08-21T00:00:00.000Z", finishedAt: "2026-08-21T00:01:00.000Z", selected: 1, succeeded: 1, failed: [] },
  };
  const reader = createJobCoverageReader({ sources: companies, store: { read: async () => snapshot, write: async () => undefined } });

  expect(await reader.getCoverage({ countries: ["in"] })).toEqual({
    snapshotUpdatedAt: snapshot.updatedAt,
    countries: [{ country: "IN", indexedSourcesWithEligibleJobs: 1, eligibleJobs: 1, distinctEligibleEmployers: 1 }],
  });
  await expect(reader.getCoverage({ countries: ["IN"], resume: "secret" })).rejects.toThrow("does not accept field: resume");
  await expect(reader.getCoverage({ countries: [] })).rejects.toThrow("at least one country");
});

function job(id: string, eligibleCountries: string[]): Job {
  return {
    id, company: id, title: "Engineer", location: "Remote", remote: true, workMode: "remote",
    eligibleCountries, excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit",
    url: `https://example.test/${id}`, description: "Build systems",
  };
}
