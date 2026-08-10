import { expect, test } from "bun:test";
import { createSnapshotCatalog } from "../src/snapshot-catalog.ts";
import type { Job, JobSnapshot } from "../src/types.ts";

test("snapshot catalog searches and retrieves jobs without network access", async () => {
  const job: Job = {
    id: "greenhouse:acme:1", company: "Acme", title: "Backend Engineer", location: "Berlin, Germany",
    remote: false, workMode: "onsite", eligibleCountries: ["DE"], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit",
    url: "https://example.test/1", description: "Build the backend",
  };
  const snapshot: JobSnapshot = {
    version: 1, updatedAt: "2026-08-10T00:00:00.000Z",
    partitions: { acme: { fetchedAt: "2026-08-10T00:00:00.000Z", jobs: [job] } },
    lastCrawl: { startedAt: "2026-08-10T00:00:00.000Z", finishedAt: "2026-08-10T00:00:00.000Z", selected: 1, succeeded: 1, failed: [] },
  };
  const catalog = createSnapshotCatalog({ read: async () => snapshot, write: async () => undefined });

  expect(await catalog.search({ query: "backend", country: "DE" })).toEqual([
    expect.objectContaining({ id: job.id, title: job.title }),
  ]);
  expect(await catalog.get(job.id)).toEqual(job);
});
