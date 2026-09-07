import { expect, test } from "bun:test";
import { createCrawler, type SnapshotStore } from "../src/crawler.ts";
import { createCrawlReporter, fetchSeedSnapshot, type CrawlReportPayload } from "../src/crawl-reporting.ts";
import { createJobSearchPreparer } from "../src/job-search-preparation.ts";
import type { Company, Job, JobSnapshot } from "../src/types.ts";

const sources: Company[] = [
  { slug: "acme", name: "Acme", ats: "greenhouse", token: "acme" },
  { slug: "failing", name: "Failing", ats: "lever", token: "failing" },
];
const job = (id: string): Job => ({
  id, company: "Acme", title: "Engineer", location: "Remote", remote: true, workMode: "remote",
  eligibleCountries: [], excludedCountries: [], eligibleRegions: ["worldwide"], eligibilityConfidence: "explicit", url: `https://example.test/${id}`, description: "Build systems",
});

test("crawler reports each succeeded source after the snapshot is written and ignores reporter failures", async () => {
  let snapshot: JobSnapshot | null = null;
  const store: SnapshotStore = { read: async () => snapshot, write: async (next) => { snapshot = next; } };
  const reported: Array<{ slug: string; persisted: boolean }> = [];
  const crawler = createCrawler({
    store, maxAttempts: 1,
    fetchJobs: async (source) => { if (source.slug === "failing") throw new Error("HTTP 503"); return [job("greenhouse:acme:1")]; },
    onCrawled: (source, partition) => {
      reported.push({ slug: source.slug, persisted: snapshot?.partitions[source.slug]?.jobs.length === partition.jobs.length });
      throw new Error("aggregator down");
    },
  });
  const report = await crawler.crawl(sources);
  expect(report.succeeded).toBe(1);
  expect(reported).toEqual([{ slug: "acme", persisted: true }]);
});

test("crawl reporter posts a gzipped partition to the aggregator and surfaces rejections", async () => {
  const calls: Array<{ url: string; payload: CrawlReportPayload; encoding: string | null }> = [];
  let status = 200;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), encoding: headers.get("content-encoding"), payload: JSON.parse(new TextDecoder().decode(Bun.gunzipSync(init?.body as Uint8Array<ArrayBuffer>))) });
    return new Response(null, { status });
  }) as typeof fetch;
  const reporter = createCrawlReporter({ url: "https://aggregator.test/base", fetcher });
  await reporter(sources[0]!, { fetchedAt: "2026-09-07T00:00:00.000Z", jobs: [job("greenhouse:acme:1")] });
  expect(calls[0]?.url).toBe("https://aggregator.test/base/v1/crawls");
  expect(calls[0]?.encoding).toBe("gzip");
  expect(calls[0]?.payload).toEqual({ version: 1, source: { slug: "acme", ats: "greenhouse", token: "acme" }, fetchedAt: "2026-09-07T00:00:00.000Z", jobs: [job("greenhouse:acme:1")] });
  status = 400;
  await expect(reporter(sources[0]!, { fetchedAt: "2026-09-07T00:00:00.000Z", jobs: [] })).rejects.toThrow("HTTP 400");
});

test("setup seeds an empty data directory from the published snapshot instead of crawling", async () => {
  const published: JobSnapshot = {
    version: 1, updatedAt: "2026-09-07T00:00:00.000Z",
    partitions: { acme: { fetchedAt: "2026-09-07T00:00:00.000Z", jobs: [job("greenhouse:acme:1")] }, failing: { fetchedAt: "2026-09-07T00:00:00.000Z", jobs: [] } },
    lastCrawl: { startedAt: "2026-09-07T00:00:00.000Z", finishedAt: "2026-09-07T00:00:00.000Z", selected: 2, succeeded: 2, failed: [] },
  };
  const fetcher = (async (url: string | URL | Request) => String(url) === "https://aggregator.test/v1/snapshot" ? Response.json(published) : new Response(null, { status: 404 })) as typeof fetch;
  expect(await fetchSeedSnapshot("https://aggregator.test", fetcher)).toEqual(published);
  expect(await fetchSeedSnapshot("https://aggregator.test/missing", fetcher)).toBeNull();

  let snapshot = null as JobSnapshot | null;
  const crawled: string[][] = [];
  const preparer = createJobSearchPreparer({
    sources, now: () => new Date("2026-09-07T01:00:00.000Z"),
    store: { read: async () => snapshot, write: async (value) => { snapshot = value; } },
    seed: () => fetchSeedSnapshot("https://aggregator.test", fetcher),
    crawl: async ({ slugs }) => { crawled.push(slugs ?? []); return { startedAt: "", finishedAt: "", selected: 0, succeeded: 0, failed: [] }; },
  });
  const result = await preparer.prepare({ countries: ["IN"] });
  expect(crawled).toEqual([]);
  expect(result.status).toBe("ready");
  expect(result.networkAttempted).toBe(false);
  expect(snapshot).toEqual(published);
});

test("an unreachable, hanging, or misconfigured aggregator never breaks setup", async () => {
  const { resolveAggregatorUrl } = await import("../src/crawl-reporting.ts");
  expect(resolveAggregatorUrl(undefined)).toBeUndefined();
  expect(resolveAggregatorUrl("   ")).toBeUndefined();
  expect(resolveAggregatorUrl("not a url")).toBeUndefined();
  expect(resolveAggregatorUrl("ftp://aggregator.test")).toBeUndefined();
  expect(resolveAggregatorUrl(" https://aggregator.test ")).toBe("https://aggregator.test/");

  const hanging = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
  })) as typeof fetch;
  const refused = (async () => { throw new TypeError("Unable to connect"); }) as unknown as typeof fetch;

  const started = Date.now();
  expect(await fetchSeedSnapshot("https://aggregator.test", hanging, 50)).toBeNull();
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(await fetchSeedSnapshot("https://aggregator.test", refused)).toBeNull();

  let snapshot = null as JobSnapshot | null;
  const store: SnapshotStore = { read: async () => snapshot, write: async (next) => { snapshot = next; } };
  const crawler = createCrawler({
    store, maxAttempts: 1,
    fetchJobs: async () => [job("greenhouse:acme:1")],
    onCrawled: createCrawlReporter({ url: "https://aggregator.test", fetcher: hanging, timeoutMs: 50 }),
  });
  const report = await crawler.crawl([sources[0]!]);
  expect(report.succeeded).toBe(1);
  expect(snapshot?.partitions.acme?.jobs).toHaveLength(1);

  snapshot = null;
  let crawls = 0;
  const preparer = createJobSearchPreparer({
    sources: [sources[0]!], now: () => new Date("2026-09-07T01:00:00.000Z"), store,
    seed: () => fetchSeedSnapshot("https://aggregator.test", refused),
    crawl: async () => { crawls += 1; snapshot = { version: 1, updatedAt: "2026-09-07T01:00:00.000Z", partitions: { acme: { fetchedAt: "2026-09-07T01:00:00.000Z", jobs: [] } }, lastCrawl: { startedAt: "", finishedAt: "", selected: 1, succeeded: 1, failed: [] } }; return snapshot.lastCrawl; },
  });
  const result = await preparer.prepare({ countries: ["IN"] });
  expect(crawls).toBe(1);
  expect(result.status).toBe("ready");
});
