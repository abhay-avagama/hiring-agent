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

  expect(Object.keys(snapshot.partitions).sort()).toEqual(["failing", "healthy", "untouched"]);
  expect(snapshot.partitions.failing?.jobs[0]?.id).toBe("old:failing:1");
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

test("a freshness window skips cached sources and crawls missing or expired partitions", async () => {
  const now = new Date("2026-08-12T12:00:00.000Z");
  let snapshot: JobSnapshot = {
    version: 1, updatedAt: "2026-08-12T11:30:00.000Z",
    partitions: {
      fresh: { fetchedAt: "2026-08-12T11:30:00.000Z", jobs: [job("lever:fresh:1", "Fresh")] },
      expired: { fetchedAt: "2026-08-10T00:00:00.000Z", jobs: [job("lever:expired:1", "Expired")] },
    },
    lastCrawl: { startedAt: "2026-08-12T11:30:00.000Z", finishedAt: "2026-08-12T11:30:00.000Z", selected: 2, succeeded: 2, failed: [] },
  };
  const fetched: string[] = [];
  const crawler = createCrawler({
    store: { read: async () => snapshot, write: async (next) => { snapshot = next; } },
    now: () => now,
    sourceFreshnessMs: 24 * 60 * 60 * 1000,
    fetchJobs: async (source) => { fetched.push(source.slug); return [job(`lever:${source.slug}:new`, source.name)]; },
  });
  const sources: Company[] = [
    { slug: "fresh", name: "Fresh", ats: "lever", token: "fresh" },
    { slug: "expired", name: "Expired", ats: "lever", token: "expired" },
    { slug: "missing", name: "Missing", ats: "lever", token: "missing" },
  ];

  const report = await crawler.crawl(sources);

  expect(fetched).toEqual(["missing", "expired"]);
  expect(report).toEqual(expect.objectContaining({ considered: 3, selected: 2, cached: 1, succeeded: 2 }));
  expect(snapshot.partitions.fresh?.jobs[0]?.id).toBe("lever:fresh:1");
});

test("a bounded cached crawl prioritizes missing then oldest sources and preserves stale jobs on failure", async () => {
  const now = new Date("2026-08-12T12:00:00.000Z");
  let snapshot: JobSnapshot = {
    version: 1, updatedAt: "2026-08-10T00:00:00.000Z",
    partitions: {
      older: { fetchedAt: "2026-08-01T00:00:00.000Z", jobs: [job("lever:older:stale", "Older")] },
      newer: { fetchedAt: "2026-08-02T00:00:00.000Z", jobs: [job("lever:newer:stale", "Newer")] },
    },
    lastCrawl: { startedAt: "2026-08-10T00:00:00.000Z", finishedAt: "2026-08-10T00:00:00.000Z", selected: 2, succeeded: 2, failed: [] },
  };
  const fetched: string[] = [];
  const crawler = createCrawler({
    store: { read: async () => snapshot, write: async (next) => { snapshot = next; } },
    now: () => now, sourceFreshnessMs: 86_400_000, sourceLimit: 2,
    fetchJobs: async (source) => {
      fetched.push(source.slug);
      if (source.slug === "older") throw new Error("HTTP 429");
      return [job(`lever:${source.slug}:new`, source.name)];
    },
  });
  const sources: Company[] = [
    { slug: "newer", name: "Newer", ats: "lever", token: "newer" },
    { slug: "older", name: "Older", ats: "lever", token: "older" },
    { slug: "missing", name: "Missing", ats: "lever", token: "missing" },
  ];

  const report = await crawler.crawl(sources);

  expect(fetched).toEqual(["missing", "older", "older"]);
  expect(report).toEqual(expect.objectContaining({ considered: 3, selected: 2, cached: 0, deferred: 1, succeeded: 1 }));
  expect(snapshot.partitions.older?.jobs[0]?.id).toBe("lever:older:stale");
  expect(snapshot.partitions.missing?.jobs[0]?.id).toBe("lever:missing:new");
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
    observer?.onBackoff?.({ status: 429, delayMs: 750 });
    observer?.onBackoff?.({ status: 503, delayMs: 500 });
    return [];
  } });
  const report = await crawler.crawl([{ slug: "limited", name: "Limited", ats: "workday", token: "example.test/example/jobs" }]);
  expect(report.sources?.[0]).toEqual(expect.objectContaining({ throttles: 1, backoffMs: 1250 }));
});

test("paces concurrent source starts and retries through one global gate", async () => {
  let clock = 0;
  const starts: string[] = [];
  const delays: number[] = [];
  const attempts = new Map<string, number>();
  const store = { read: async () => null, write: async (_next: JobSnapshot) => undefined };
  const crawler = createCrawler({
    store, concurrency: 2, sourceStartDelayMs: 500, pacingNow: () => clock, pacingSleep: async (delayMs) => { delays.push(delayMs); clock += delayMs; },
    fetchJobs: async (source) => {
      starts.push(source.slug);
      const attempt = (attempts.get(source.slug) ?? 0) + 1;
      attempts.set(source.slug, attempt);
      if (source.slug === "paced-0" && attempt === 1) throw new Error("HTTP 503");
      return [];
    },
  });
  const sources: Company[] = Array.from({ length: 2 }, (_, index) => ({ slug: `paced-${index}`, name: `Paced ${index}`, ats: "lever", token: `paced-${index}` }));
  await crawler.crawl(sources);
  expect(starts).toEqual(["paced-0", "paced-1", "paced-0"]);
  expect(delays).toEqual([500, 500]);
});

test("zero source delay preserves concurrent crawl behavior without sleeping", async () => {
  let sleeps = 0;
  const store = { read: async () => null, write: async (_next: JobSnapshot) => undefined };
  const crawler = createCrawler({ store, sourceStartDelayMs: 0, pacingSleep: async () => { sleeps += 1; }, fetchJobs: async () => [] });
  await crawler.crawl([{ slug: "immediate", name: "Immediate", ats: "lever", token: "immediate" }]);
  expect(sleeps).toBe(0);
});

test("required experience comes from the description, the last crawl, or one detail fetch for recent roles in the chosen countries", async () => {
  const listed = (id: string, extra: Partial<Job>): Job => ({ ...job(id, "Acme"), description: "", eligibleCountries: ["IN"], updatedAt: "2026-08-08", ...extra });
  let snapshot: JobSnapshot = {
    version: 1, updatedAt: "2026-08-09T00:00:00.000Z",
    partitions: { acme: { fetchedAt: "2026-08-09T00:00:00.000Z", jobs: [{ ...listed("workday:acme:known", {}), experience: { min: 4 } }] } },
    lastCrawl: { startedAt: "2026-08-09T00:00:00.000Z", finishedAt: "2026-08-09T00:00:00.000Z", selected: 1, succeeded: 1, failed: [] },
  };
  const store: SnapshotStore = { read: async () => snapshot, write: async (next) => { snapshot = next; } };
  const described: string[] = [];
  const crawler = createCrawler({
    store, now: () => new Date("2026-08-10T10:00:00.000Z"), describeCountries: ["IN"],
    describe: async (_source, target) => { described.push(target.id); return target.id.endsWith("silent") ? "Join a great team." : "Experience: 2-5 years"; },
    fetchJobs: async () => [
      listed("workday:acme:inline", { description: "7+ years of experience in Java" }),
      listed("workday:acme:known", {}),
      listed("workday:acme:new", {}),
      listed("workday:acme:silent", {}),
      listed("workday:acme:us", { eligibleCountries: ["US"] }),
      listed("workday:acme:old", { updatedAt: "2026-06-01" }),
    ],
  });
  await crawler.crawl([{ slug: "acme", name: "Acme", ats: "workday", token: "acme.wd1.myworkdayjobs.com/acme/Careers" }]);
  const experience = Object.fromEntries(snapshot.partitions.acme!.jobs.map((item) => [item.id.split(":")[2], item.experience]));
  expect(experience).toEqual({ inline: { min: 7 }, known: { min: 4 }, new: { min: 2, max: 5 }, silent: null, us: undefined, old: undefined });
  expect(described).toEqual(["workday:acme:new", "workday:acme:silent"]);
});
