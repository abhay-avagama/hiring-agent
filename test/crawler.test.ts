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

test("a full crawl prunes partitions no longer in the verified catalog", async () => {
  const healthy: Company = { slug: "healthy", name: "Healthy", ats: "greenhouse", token: "healthy" };
  const snapshot: JobSnapshot = {
    version: 1, updatedAt: "2026-01-01T00:00:00.000Z",
    partitions: {
      healthy: { fetchedAt: "2026-01-01T00:00:00.000Z", jobs: [] },
      retired: { fetchedAt: "2026-01-01T00:00:00.000Z", jobs: [job("old:retired:1", "Retired")] },
    },
    lastCrawl: { startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.000Z", selected: 2, succeeded: 2, failed: [] },
  };
  let written: JobSnapshot | undefined;
  const store = {
    read: async () => snapshot,
    write: async (next: JobSnapshot) => { written = next; },
  };
  const crawler = createCrawler({ store, fetchJobs: async () => [] });
  await crawler.crawl([healthy], { prune: true });
  expect(Object.keys(written!.partitions)).toEqual(["healthy"]);
});

test("a source that exceeds its timeout is aborted and reported", async () => {
  let written: JobSnapshot | undefined;
  const store = { read: async () => null, write: async (next: JobSnapshot) => { written = next; } };
  const crawler = createCrawler({
    store, timeoutMs: 5,
    fetchJobs: async (_source, signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason))),
  });
  const report = await crawler.crawl([{ slug: "slow", name: "Slow", ats: "lever", token: "slow" }]);
  expect(report.failed[0]).toEqual(expect.objectContaining({ source: "slow", error: "Timed out after 5ms" }));
  expect(written?.partitions).toEqual({});
});

test("transient source failures are retried after the initial crawl wave", async () => {
  let attempts = 0;
  let written: JobSnapshot | undefined;
  const store = { read: async () => null, write: async (next: JobSnapshot) => { written = next; } };
  const crawler = createCrawler({
    store,
    fetchJobs: async (source) => {
      attempts += 1;
      if (attempts === 1) throw new Error("job board returned HTTP 520");
      return [job("workday:transient:1", source.name)];
    },
  });

  const report = await crawler.crawl([{ slug: "transient", name: "Transient", ats: "workday", token: "example.test/example/jobs" }]);

  expect(attempts).toBe(2);
  expect(report).toEqual(expect.objectContaining({ selected: 1, succeeded: 1, failed: [] }));
  expect(report.sources).toEqual([expect.objectContaining({ source: "transient", status: "succeeded", attempts: 2, jobs: 1 })]);
  expect(written?.partitions.transient?.jobs).toHaveLength(1);
});

test("reports provider throttling and backoff per source", async () => {
  const store = { read: async () => null, write: async (_next: JobSnapshot) => undefined };
  const crawler = createCrawler({ store, fetchJobs: async (_source, _signal, observer) => {
    observer?.onBackoff({ status: 429, delayMs: 750 });
    observer?.onBackoff({ status: 503, delayMs: 500 });
    return [];
  } });
  const report = await crawler.crawl([{ slug: "limited", name: "Limited", ats: "workday", token: "example.test/example/jobs" }]);
  expect(report.sources?.[0]).toEqual(expect.objectContaining({ throttles: 1, backoffMs: 1250 }));
});

test("paces source starts globally across concurrent workers", async () => {
  const starts: number[] = [];
  const store = { read: async () => null, write: async (_next: JobSnapshot) => undefined };
  const crawler = createCrawler({ store, concurrency: 3, sourceStartDelayMs: 15, fetchJobs: async () => { starts.push(Date.now()); return []; } });
  const sources: Company[] = Array.from({ length: 3 }, (_, index) => ({ slug: `paced-${index}`, name: `Paced ${index}`, ats: "lever", token: `paced-${index}` }));
  await crawler.crawl(sources);
  expect(starts).toHaveLength(3);
  expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(10);
  expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(10);
});
