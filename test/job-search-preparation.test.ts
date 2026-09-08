import { expect, test } from "bun:test";
import { createJobSearchPreparer } from "../src/job-search-preparation.ts";
import type { Company, JobSnapshot } from "../src/types.ts";

const sources: Company[] = [
  { slug: "acme", name: "Acme", ats: "greenhouse", token: "acme", companyDomain: "acme.test" },
  { slug: "globex", name: "Globex", ats: "workday", token: "globex:Careers", companyDomain: "globex.test" },
];

test("prepare_job_search crawls only missing verified sources and returns requested-country coverage", async () => {
  let snapshot: JobSnapshot = {
    version: 1,
    updatedAt: "2026-08-30T00:00:00.000Z",
    partitions: {
      acme: {
        fetchedAt: "2026-08-30T00:00:00.000Z",
        jobs: [{
          id: "greenhouse:acme:1", company: "Acme", title: "Engineer", location: "Bengaluru, India", remote: false,
          workMode: "onsite", eligibleCountries: ["IN"], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit",
          url: "https://example.test/acme/1", description: "Build systems.",
        }],
      },
    },
    lastCrawl: { startedAt: "2026-08-30T00:00:00.000Z", finishedAt: "2026-08-30T00:00:00.000Z", selected: 1, succeeded: 1, failed: [] },
  };
  const crawled: string[][] = [];
  const preparer = createJobSearchPreparer({
    sources,
    now: () => new Date("2026-08-31T00:00:00.000Z"),
    store: { read: async () => snapshot, write: async (value) => { snapshot = value; } },
    crawl: async ({ slugs }) => {
      crawled.push(slugs ?? []);
      snapshot = {
        ...snapshot,
        updatedAt: "2026-08-31T00:00:00.000Z",
        partitions: {
          ...snapshot.partitions,
          globex: {
            fetchedAt: "2026-08-31T00:00:00.000Z",
            jobs: [{
              id: "workday:globex:2", company: "Globex", title: "Developer", location: "Berlin, Germany", remote: false,
              workMode: "onsite", eligibleCountries: ["DE"], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit",
              url: "https://example.test/globex/2", description: "Build software.",
            }],
          },
        },
      };
      return { startedAt: "2026-08-31T00:00:00.000Z", finishedAt: "2026-08-31T00:00:01.000Z", selected: 1, succeeded: 1, failed: [] };
    },
  });

  const result = await preparer.prepare({ countries: ["in", "DE"] });

  expect(crawled).toEqual([["globex"]]);
  expect(result.status).toBe("ready");
  expect(result.nextAction).toBe("ready");
  expect(result.networkAttempted).toBe(true);
  expect(result.sources).toEqual({ catalog: 2, indexed: 2, fresh: 2, stale: 0, missing: 0, pending: 0 });
  expect(result.coverage.countries).toEqual([
    { country: "IN", indexedSourcesWithEligibleJobs: 1, eligibleJobs: 1, distinctEligibleEmployers: 1 },
    { country: "DE", indexedSourcesWithEligibleJobs: 1, eligibleJobs: 1, distinctEligibleEmployers: 1 },
  ]);
});

test("prepare_job_search is offline and idempotent once every verified source is indexed", async () => {
  const complete: JobSnapshot = {
    version: 1,
    updatedAt: "2026-08-31T00:00:00.000Z",
    partitions: Object.fromEntries(sources.map((source) => [source.slug, { fetchedAt: "2026-08-31T00:00:00.000Z", jobs: [] }])),
    lastCrawl: { startedAt: "2026-08-31T00:00:00.000Z", finishedAt: "2026-08-31T00:00:00.000Z", selected: 2, succeeded: 2, failed: [] },
  };
  let crawls = 0;
  const preparer = createJobSearchPreparer({
    sources,
    now: () => new Date("2026-08-31T00:00:00.000Z"),
    store: { read: async () => complete, write: async () => undefined },
    crawl: async () => { crawls += 1; throw new Error("crawl should not run"); },
  });

  const result = await preparer.prepare({ countries: ["IN"] });

  expect(crawls).toBe(0);
  expect(result).toEqual(expect.objectContaining({ status: "ready", nextAction: "ready", networkAttempted: false, sources: { catalog: 2, indexed: 2, fresh: 2, stale: 0, missing: 0, pending: 0 } }));
});

test("prepare_job_search refreshes stale sources and reports them when refresh fails", async () => {
  const stale: JobSnapshot = {
    version: 1,
    updatedAt: "2026-08-01T00:00:00.000Z",
    partitions: Object.fromEntries(sources.map((source) => [source.slug, { fetchedAt: "2026-08-01T00:00:00.000Z", jobs: [] }])),
    lastCrawl: { startedAt: "2026-08-01T00:00:00.000Z", finishedAt: "2026-08-01T00:00:00.000Z", selected: 2, succeeded: 2, failed: [] },
  };
  const crawled: string[][] = [];
  const preparer = createJobSearchPreparer({
    sources,
    now: () => new Date("2026-08-31T00:00:00.000Z"),
    store: { read: async () => stale, write: async () => undefined },
    crawl: async ({ slugs }) => {
      crawled.push(slugs ?? []);
      return {
        startedAt: "2026-08-31T00:00:00.000Z", finishedAt: "2026-08-31T00:00:01.000Z",
        selected: 2, succeeded: 0, failed: sources.map((source) => ({ source: source.slug, error: "unavailable" })),
      };
    },
  });

  const result = await preparer.prepare({ countries: ["IN"] });

  expect(crawled).toEqual([["acme", "globex"]]);
  expect(result).toEqual(expect.objectContaining({
    status: "partial",
    nextAction: "retry_later",
    networkAttempted: true,
    sources: { catalog: 2, indexed: 2, fresh: 0, stale: 2, missing: 0, pending: 2 },
  }));
});

test("prepare_job_search advances through bounded batches", async () => {
  const manySources = Array.from({ length: 12 }, (_, index): Company => ({
    slug: `source-${index.toString().padStart(2, "0")}`,
    name: `Source ${index}`,
    ats: "greenhouse",
    token: `source-${index}`,
  }));
  let snapshot: JobSnapshot | null = null;
  const selected: string[][] = [];
  const preparer = createJobSearchPreparer({
    batchSize: 10,
    sources: manySources,
    now: () => new Date("2026-08-31T00:00:00.000Z"),
    store: { read: async () => snapshot, write: async (value) => { snapshot = value; } },
    crawl: async ({ slugs }) => {
      selected.push(slugs ?? []);
      const partitions = { ...(snapshot?.partitions ?? {}) };
      for (const slug of slugs ?? []) partitions[slug] = { fetchedAt: "2026-08-31T00:00:00.000Z", jobs: [] };
      const report = { startedAt: "2026-08-31T00:00:00.000Z", finishedAt: "2026-08-31T00:00:01.000Z", selected: slugs?.length ?? 0, succeeded: slugs?.length ?? 0, failed: [] };
      snapshot = { version: 1, updatedAt: report.finishedAt, partitions, lastCrawl: report };
      return report;
    },
  });

  const first = await preparer.prepare({ countries: ["IN"] });
  const second = await preparer.prepare({ countries: ["IN"] });

  expect(selected.map((batch) => batch.length)).toEqual([10, 2]);
  expect(first).toEqual(expect.objectContaining({ status: "partial", nextAction: "call_again", sources: expect.objectContaining({ pending: 2 }) }));
  expect(second).toEqual(expect.objectContaining({ status: "ready", nextAction: "ready", sources: expect.objectContaining({ pending: 0 }) }));
});

test("prepare_job_search continues past an all-failed batch and stops after every source was attempted", async () => {
  const manySources = Array.from({ length: 12 }, (_, index): Company => ({
    slug: `source-${index.toString().padStart(2, "0")}`,
    name: `Source ${index}`,
    ats: "greenhouse",
    token: `source-${index}`,
  }));
  let snapshot: JobSnapshot | null = null;
  const preparer = createJobSearchPreparer({
    batchSize: 10,
    sources: manySources,
    now: () => new Date("2026-08-31T00:00:00.000Z"),
    store: { read: async () => snapshot, write: async (value) => { snapshot = value; } },
    crawl: async ({ slugs }) => {
      const failed = (slugs ?? []).map((source) => ({ source, error: "unavailable" }));
      const report = { startedAt: "2026-08-31T00:00:00.000Z", finishedAt: "2026-08-31T00:00:01.000Z", selected: failed.length, succeeded: 0, failed };
      snapshot = { version: 1, updatedAt: report.finishedAt, partitions: {}, lastCrawl: report };
      return report;
    },
  });

  const result = await preparer.prepare({ countries: ["IN"] });
  const final = await preparer.prepare({ countries: ["IN"], continuation: result.continuation });

  expect(result).toEqual(expect.objectContaining({ status: "partial", nextAction: "call_again", continuation: expect.any(String), sources: expect.objectContaining({ pending: 12 }) }));
  expect(final).toEqual(expect.objectContaining({ status: "partial", nextAction: "retry_later", sources: expect.objectContaining({ pending: 12 }) }));
});

test("prepare_job_search continuation is bound to its requested countries", async () => {
  let snapshot: JobSnapshot | null = null;
  const preparer = createJobSearchPreparer({
    sources,
    store: { read: async () => snapshot, write: async (value) => { snapshot = value; } },
    crawl: async ({ slugs }) => {
      const report = { startedAt: "2026-08-31T00:00:00.000Z", finishedAt: "2026-08-31T00:00:01.000Z", selected: slugs?.length ?? 0, succeeded: 0, failed: (slugs ?? []).map((source) => ({ source, error: "unavailable" })) };
      snapshot = { version: 1, updatedAt: report.finishedAt, partitions: {}, lastCrawl: report };
      return report;
    },
    batchSize: 1,
  });
  const first = await preparer.prepare({ countries: ["IN"] });

  await expect(preparer.prepare({ countries: ["DE"], continuation: first.continuation })).rejects.toThrow("valid preparation token for the requested countries");
});
