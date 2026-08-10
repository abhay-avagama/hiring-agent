import { expect, test } from "bun:test";
import { createLocalJobs } from "../src/local-jobs.ts";
import type { Company, Job, JobSnapshot } from "../src/types.ts";

const source: Company = { slug: "acme", name: "Acme", ats: "greenhouse", token: "acme", cohorts: ["IN"] };
const makeJob = (id: string): Job => ({
  id, company: "Acme", title: "Engineer", location: "India", remote: false, workMode: "onsite",
  eligibleCountries: ["IN"], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit",
  url: `https://example.test/${id}`, description: "Build",
});

test("stale snapshots refresh automatically while offline searches keep existing data", async () => {
  let fetches = 0;
  let snapshot: JobSnapshot = {
    version: 1, updatedAt: "2026-01-01T00:00:00.000Z",
    partitions: { acme: { fetchedAt: "2026-01-01T00:00:00.000Z", jobs: [makeJob("old")] } },
    lastCrawl: { startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.000Z", selected: 1, succeeded: 1, failed: [] },
  };
  const store = { read: async () => snapshot, write: async (next: JobSnapshot) => { snapshot = next; } };
  const local = createLocalJobs({
    sources: [source], store, now: () => new Date("2026-08-10T00:00:00.000Z"),
    fetchJobs: async () => { fetches += 1; return [makeJob("fresh")]; },
  });

  expect((await local.search({}, { offline: true, staleDays: 14 })).jobs[0]?.id).toBe("old");
  expect((await local.search({}, { offline: false, staleDays: 14 })).jobs[0]?.id).toBe("fresh");
  expect(fetches).toBe(1);
});

test("crawl scopes select all sources, a country cohort, or explicit slugs", async () => {
  const fetched: string[] = [];
  let snapshot: JobSnapshot | null = null;
  const sources: Company[] = [
    source,
    { slug: "global", name: "Global", ats: "lever", token: "global" },
    { slug: "germany", name: "Germany", ats: "ashby", token: "germany", cohorts: ["DE"] },
  ];
  const local = createLocalJobs({
    sources,
    store: { read: async () => snapshot, write: async (next) => { snapshot = next; } },
    fetchJobs: async (company) => { fetched.push(company.slug); return []; },
  });

  await local.crawl({ country: "in" });
  expect(fetched).toEqual(["acme"]);
  fetched.length = 0;
  await local.crawl({ slugs: ["global", "germany"] });
  expect(fetched.sort()).toEqual(["germany", "global"]);
  expect(() => local.crawl({ slugs: ["missing"] })).toThrow("Unknown company source");
});
