import { expect, test } from "bun:test";
import { auditSearchCoverage } from "../scripts/audit-search-coverage.ts";
import type { Job, JobSnapshot } from "../src/types.ts";

test("coverage audit separates review signals from facts and is deterministic", () => {
  const job: Job = { id: "lever:test:1", company: "Example", title: "Backend Engineer", location: "London, United Kingdom", remote: false, workMode: "onsite", eligibleCountries: ["IN"], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit", url: "https://example.test/1", description: "", experience: { min: 3 }, updatedAt: "2026-09-15" };
  const snapshot: JobSnapshot = { version: 1, updatedAt: "2026-09-16T00:00:00Z", lastCrawl: { startedAt: "2026-09-15", finishedAt: "2026-09-15", selected: 1, succeeded: 1, failed: [] }, partitions: { test: { fetchedAt: "2026-09-15", jobs: [job, { ...job, id: "lever:test:2" }] } } };
  const report = auditSearchCoverage(snapshot);
  expect(report.eligibleJobs).toBe(2);
  expect(report.locationReview.count).toBe(2);
  expect(report.possibleDuplicateGroups).toBe(1);
  expect(report.missingDescription).toBe(2);
  expect(report.missingDescriptionsByProvider).toEqual({ lever: 2 });
  expect(report.experienceByStatedMinimum.threeToFive).toBe(2);
  expect(report.age.within7Days).toBe(2);
  expect(JSON.stringify(report)).toBe(JSON.stringify(auditSearchCoverage({ ...snapshot, partitions: { test: { ...snapshot.partitions.test!, jobs: [...snapshot.partitions.test!.jobs].reverse() } } })));
});
