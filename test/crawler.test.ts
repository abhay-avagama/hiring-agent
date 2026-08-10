import { expect, test } from "bun:test";
import { createCrawler, type SnapshotStore } from "../src/crawler.ts";
import type { Company, Job, JobSnapshot } from "../src/types.ts";

const job = (id: string, company: string): Job => ({
  id, company, title: "Engineer", location: "Remote", remote: true,
  workMode: "remote", eligibleCountries: [], excludedCountries: [], eligibleRegions: ["worldwide"], eligibilityConfidence: "explicit",
  url: `https://example.test/${id}`, description: "Build systems",
});

test("a scoped crawl replaces successes, removes failures, and preserves unselected partitions", async () => {
  let snapshot: JobSnapshot = {
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    partitions: {
      untouched: { fetchedAt: "2026-01-01T00:00:00.000Z", jobs: [job("old:untouched:1", "Untouched")] },
      failing: { fetchedAt: "2026-01-01T00:00:00.000Z", jobs: [job("old:failing:1", "Failing")] },
    },
    lastCrawl: { startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.000Z", selected: 2, succeeded: 2, failed: [] },
  };
  const store: SnapshotStore = { read: async () => snapshot, write: async (next) => { snapshot = next; } };
  const sources: Company[] = [
    { slug: "healthy", name: "Healthy", ats: "greenhouse", token: "healthy" },
    { slug: "failing", name: "Failing", ats: "lever", token: "failing" },
  ];
  const crawler = createCrawler({
    store,
    now: () => new Date("2026-08-10T10:00:00.000Z"),
    fetchJobs: async (source) => {
      if (source.slug === "failing") throw new Error("HTTP 503");
      return [job("greenhouse:healthy:1", source.name)];
    },
  });

  const report = await crawler.crawl(sources);

  expect(Object.keys(snapshot.partitions).sort()).toEqual(["healthy", "untouched"]);
  expect(report).toEqual(expect.objectContaining({ selected: 2, succeeded: 1 }));
  expect(report.failed).toEqual([{ source: "failing", error: "HTTP 503" }]);
});
