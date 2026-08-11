import { expect, test } from "bun:test";
import { createJobRecommender } from "../src/job-recommendations.ts";
import type { Company, Job, JobSnapshot } from "../src/types.ts";

const source: Company = { slug: "acme", name: "Acme", ats: "greenhouse", token: "acme", cohorts: ["IN"] };

test("refresh never reads and ranks the local snapshot without crawling", async () => {
  let crawls = 0;
  const snapshot = makeSnapshot([job("java", "Java is required."), job("ruby", "Ruby is required.")], "2026-01-01T00:00:00Z");
  const recommender = createJobRecommender({
    sources: [source],
    store: { read: async () => snapshot, write: async () => undefined },
    crawl: async () => { crawls += 1; throw new Error("must not crawl"); },
    now: () => new Date("2026-08-11T00:00:00Z"),
  });

  const result = await recommender.recommend({
    resume: { content: "Skills\nJava", format: "text" },
    intent: { countries: ["IN"], roles: ["backend engineer"] },
    refresh: { policy: "never", staleDays: 14 },
  });

  expect(crawls).toBe(0);
  expect(result.matches.map((match) => match.job.id)).toEqual(["java", "ruby"]);
  expect(result.refresh).toEqual({ policy: "never", attempted: false, occurred: false, reason: "policy_never", failures: [] });
  expect(result.snapshot).toEqual(expect.objectContaining({ refreshed: false, stale: true }));
});

test("auto refreshes a stale snapshot once in the requested country scope and rematches", async () => {
  let snapshot = makeSnapshot([job("old", "Ruby is required.")], "2026-01-01T00:00:00Z");
  const scopes: unknown[] = [];
  const recommender = createJobRecommender({
    sources: [source],
    store: { read: async () => snapshot, write: async (next) => { snapshot = next; } },
    crawl: async (scope) => {
      scopes.push(scope);
      snapshot = makeSnapshot([job("fresh", "Java is required.")], "2026-08-11T00:00:00Z");
      return snapshot.lastCrawl;
    },
    now: () => new Date("2026-08-11T00:00:00Z"),
  });

  const result = await recommender.recommend({ resume: { content: "Skills\nJava", format: "text" }, intent: { countries: ["IN"] } });

  expect(scopes).toEqual([{ slugs: ["acme"] }]);
  expect(result.matches.map((match) => match.job.id)).toEqual(["fresh"]);
  expect(result.refresh).toEqual({ policy: "auto", attempted: true, occurred: true, reason: "snapshot_stale", failures: [] });
  expect(result.snapshot).toEqual(expect.objectContaining({ refreshed: true, stale: false }));
});

test("auto refreshes once when qualifying matches are below the threshold and reports partial failures", async () => {
  let snapshot = makeSnapshot([job("initial", "Java is required.")]);
  let crawls = 0;
  const recommender = createJobRecommender({
    sources: [source],
    store: { read: async () => snapshot, write: async (next) => { snapshot = next; } },
    crawl: async () => {
      crawls += 1;
      snapshot = makeSnapshot([job("initial", "Java is required."), job("added", "Java is required.")], "2026-08-11T00:00:00Z");
      snapshot.lastCrawl.failed = [{ source: "slow-board", error: "Timed out" }];
      return snapshot.lastCrawl;
    },
    now: () => new Date("2026-08-11T00:00:00Z"),
  });

  const result = await recommender.recommend({
    resume: { content: "Skills\nJava", format: "text" }, intent: { countries: ["IN"] },
    refresh: { policy: "auto", minimumMatches: 3, staleDays: 14 }, limit: 1,
  });

  expect(crawls).toBe(1);
  expect(result.matches.map((match) => match.job.id)).toEqual(["initial"]);
  expect(result.refresh).toEqual({
    policy: "auto", attempted: true, occurred: true, reason: "insufficient_matches",
    failures: [{ source: "slow-board", error: "Timed out" }],
  });
  expect(result.shortfall).toEqual({
    minimumMatches: 3, actualMatches: 2,
    message: "Found 2 qualifying jobs after applying the requested constraints; 3 were requested",
  });
  expect(result.nextActions).toEqual(["Analyze fit for job initial"]);
});

test("auto skips refresh when a fresh snapshot already has enough qualifying matches", async () => {
  const snapshot = makeSnapshot([job("one", "Java is required."), job("two", "Java is required.")]);
  let crawls = 0;
  const recommender = createJobRecommender({
    sources: [source],
    store: { read: async () => snapshot, write: async () => undefined },
    crawl: async () => { crawls += 1; return snapshot.lastCrawl; },
    now: () => new Date("2026-08-11T00:00:00Z"),
  });
  const result = await recommender.recommend({
    resume: { content: "Skills\nJava", format: "text" }, intent: { countries: ["IN"] },
    refresh: { policy: "auto", minimumMatches: 2, staleDays: 14 },
  });
  expect(crawls).toBe(0);
  expect(result.refresh).toEqual({ policy: "auto", attempted: false, occurred: false, reason: "not_needed", failures: [] });
});

test("a relevance cutoff does not trigger refresh when hard-filter-qualified jobs already exist", async () => {
  const snapshot = makeSnapshot([job("one", "Java is required.")]);
  let crawls = 0;
  const recommender = createJobRecommender({
    sources: [source], store: { read: async () => snapshot, write: async () => undefined },
    crawl: async () => { crawls += 1; return snapshot.lastCrawl; }, now: () => new Date("2026-08-11T00:00:00Z"),
  });
  const result = await recommender.recommend({
    resume: { content: "Skills\nJava", format: "text" }, intent: { countries: ["IN"] },
    ranking: { mode: "evidence", minimumPercent: 100 }, refresh: { policy: "auto", minimumMatches: 1 },
  });
  expect(crawls).toBe(0);
  expect(result.matches).toEqual([]);
  expect(result.refresh.reason).toBe("not_needed");
  expect(result.shortfall).toEqual({
    minimumMatches: 1,
    actualMatches: 0,
    message: "Found 0 qualifying jobs after applying the requested constraints; 1 were requested",
  });
});

test("always refreshes once even when the snapshot is fresh", async () => {
  let snapshot = makeSnapshot([job("old", "Java is required.")]);
  let crawls = 0;
  const recommender = createJobRecommender({
    sources: [source],
    store: { read: async () => snapshot, write: async (next) => { snapshot = next; } },
    crawl: async () => {
      crawls += 1;
      snapshot = makeSnapshot([job("new", "Java is required.")], "2026-08-11T00:00:00Z");
      return snapshot.lastCrawl;
    },
    now: () => new Date("2026-08-11T00:00:00Z"),
  });
  const result = await recommender.recommend({
    resume: { content: "Skills\nJava", format: "text" }, intent: { countries: ["IN"] }, refresh: { policy: "always" },
  });
  expect(crawls).toBe(1);
  expect(result.matches[0]!.job.id).toBe("new");
  expect(result.refresh.reason).toBe("policy_always");
});

test("auto can create a missing snapshot while never fails without network access", async () => {
  let snapshot: JobSnapshot | null = null;
  let crawls = 0;
  const recommender = createJobRecommender({
    sources: [source],
    store: { read: async () => snapshot, write: async (next) => { snapshot = next; } },
    crawl: async () => {
      crawls += 1;
      snapshot = makeSnapshot([job("created", "Java is required.")]);
      return snapshot.lastCrawl;
    },
  });
  const base = { resume: { content: "Skills\nJava", format: "text" as const }, intent: { countries: ["IN"] } };

  await expect(recommender.recommend({ ...base, refresh: { policy: "never" } })).rejects.toEqual(expect.objectContaining({ code: "snapshot_unavailable" }));
  expect(crawls).toBe(0);
  const result = await recommender.recommend({ ...base, refresh: { policy: "auto" } });
  expect(crawls).toBe(1);
  expect(result.matches[0]!.job.id).toBe("created");
  expect(result.refresh.reason).toBe("snapshot_missing");
});

test("freshness is evaluated only for relevant country partitions", async () => {
  const sources: Company[] = [source, { slug: "us", name: "US Co", ats: "greenhouse", token: "us", cohorts: ["US"] }];
  const fresh = makeSnapshot([job("india", "Java is required.")]);
  fresh.partitions.us = {
    fetchedAt: "2026-01-01T00:00:00Z",
    jobs: [{ ...job("us", "Java is required."), location: "New York, US", eligibleCountries: ["US"] }],
  };
  let crawls = 0;
  const recommender = createJobRecommender({
    sources,
    store: { read: async () => fresh, write: async () => undefined },
    crawl: async () => { crawls += 1; return fresh.lastCrawl; },
    now: () => new Date("2026-08-11T00:00:00Z"),
  });
  const result = await recommender.recommend({
    resume: { content: "Skills\nJava", format: "text" }, intent: { countries: ["IN"] }, refresh: { policy: "auto", minimumMatches: 1 },
  });
  expect(crawls).toBe(0);
  expect(result.snapshot).toEqual(expect.objectContaining({ stale: false, sources: 1 }));
});

test("eligible non-cohort partitions are included in both freshness and refresh scope", async () => {
  const untagged: Company = { slug: "untagged", name: "Untagged", ats: "greenhouse", token: "untagged" };
  let snapshot = makeSnapshot([job("india", "Java is required.")]);
  snapshot.partitions.untagged = { fetchedAt: "2026-01-01T00:00:00Z", jobs: [job("eligible", "Java is required.")] };
  const scopes: unknown[] = [];
  const recommender = createJobRecommender({
    sources: [source, untagged], store: { read: async () => snapshot, write: async (next) => { snapshot = next; } },
    crawl: async (scope) => {
      scopes.push(scope);
      snapshot = makeSnapshot([job("india", "Java is required.")], "2026-08-11T00:00:00Z");
      snapshot.partitions.untagged = { fetchedAt: "2026-08-11T00:00:00Z", jobs: [job("eligible", "Java is required.")] };
      return snapshot.lastCrawl;
    },
    now: () => new Date("2026-08-11T00:00:00Z"),
  });
  const result = await recommender.recommend({
    resume: { content: "Skills\nJava", format: "text" }, intent: { countries: ["IN"] }, refresh: { policy: "auto", minimumMatches: 1 },
  });
  expect(scopes).toEqual([{ slugs: ["acme", "untagged"] }]);
  expect(result.snapshot.stale).toBe(false);
});

test("multiple target countries refresh only their bounded cohort union", async () => {
  const sources: Company[] = [source, { slug: "us", name: "US Co", ats: "greenhouse", token: "us", cohorts: ["US"] }];
  const snapshot = makeSnapshot([job("india", "Java is required.")]);
  const scopes: unknown[] = [];
  const recommender = createJobRecommender({
    sources,
    store: { read: async () => snapshot, write: async () => undefined },
    crawl: async (scope) => { scopes.push(scope); return snapshot.lastCrawl; },
  });
  await recommender.recommend({
    resume: { content: "Skills\nJava", format: "text" }, intent: { countries: ["IN", "US"] }, refresh: { policy: "always" },
  });
  expect(scopes).toEqual([{ slugs: ["acme", "us"] }]);
});

test("a thrown refresh preserves usable local recommendations and reports the orchestration failure", async () => {
  const snapshot = makeSnapshot([job("local", "Java is required.")], "2026-01-01T00:00:00Z");
  const recommender = createJobRecommender({
    sources: [source], store: { read: async () => snapshot, write: async () => undefined },
    crawl: async () => { throw new Error("store unavailable"); }, now: () => new Date("2026-08-11T00:00:00Z"),
  });
  const result = await recommender.recommend({ resume: { content: "Skills\nJava", format: "text" }, intent: { countries: ["IN"] } });
  expect(result.matches[0]!.job.id).toBe("local");
  expect(result.refresh).toEqual({
    policy: "auto", attempted: true, occurred: false, reason: "snapshot_stale", failures: [],
    error: { code: "refresh_failed", message: "store unavailable" },
  });
  expect(result.snapshot.refreshed).toBe(false);
});

test("a thrown crawl rereads and uses partitions written before the failure", async () => {
  let snapshot = makeSnapshot([job("old", "Ruby is required.")], "2026-01-01T00:00:00Z");
  const recommender = createJobRecommender({
    sources: [source], store: { read: async () => snapshot, write: async (next) => { snapshot = next; } },
    crawl: async () => {
      snapshot = makeSnapshot([job("written", "Java is required.")], "2026-08-11T00:00:00Z");
      throw new Error("later partition failed");
    },
    now: () => new Date("2026-08-11T00:00:00Z"),
  });
  const result = await recommender.recommend({
    resume: { content: "Skills\nJava\nExperience\nBackend Engineer — Acme", format: "text" }, intent: { countries: ["IN"] },
    ranking: { mode: "keyword", minimumPercent: 95 },
  });
  expect(result.matches[0]!.job.id).toBe("written");
  expect(result.matches[0]!.selectedScore).toBe(result.matches[0]!.scores.keyword);
  expect(result.matches[0]!.selectedScore).toBeGreaterThanOrEqual(95);
  expect(result.refresh).toEqual(expect.objectContaining({ attempted: true, occurred: true, error: { code: "refresh_failed", message: "later partition failed" } }));
  expect(result.snapshot.refreshed).toBe(true);
});

test("an all-failed crawl is attempted but does not claim that refresh occurred", async () => {
  let snapshot = makeSnapshot([job("local", "Java is required.")]);
  const failedReport = { ...snapshot.lastCrawl, selected: 1, succeeded: 0, failed: [{ source: "acme", error: "Timed out" }] };
  const recommender = createJobRecommender({
    sources: [source], store: { read: async () => snapshot, write: async (next) => { snapshot = next; } },
    crawl: async () => {
      snapshot = { ...snapshot, updatedAt: "2026-08-11T00:00:00Z", partitions: {}, lastCrawl: failedReport };
      return failedReport;
    },
  });
  const result = await recommender.recommend({
    resume: { content: "Skills\nJava", format: "text" }, intent: { countries: ["IN"] }, refresh: { policy: "always" },
  });
  expect(result.refresh).toEqual({
    policy: "always", attempted: true, occurred: false, reason: "policy_always",
    failures: [{ source: "acme", error: "Timed out" }],
  });
  expect(result.snapshot.refreshed).toBe(false);
});

test("invalid recommendation controls fail before reading or crawling", async () => {
  let reads = 0;
  let crawls = 0;
  const recommender = createJobRecommender({
    sources: [source],
    store: { read: async () => { reads += 1; return null; }, write: async () => undefined },
    crawl: async () => { crawls += 1; throw new Error("unexpected"); },
  });
  const base = { resume: { content: "Skills\nJava", format: "text" }, intent: {} };
  for (const input of [
    null, {}, { ...base, intent: "anywhere" }, { ...base, refresh: { policy: "sometimes" } },
    { ...base, refresh: { staleDays: -1 } }, { ...base, refresh: { minimumMatches: Number.NaN } }, { ...base, limit: 0 }, { ...base, limit: 101 },
    { ...base, extra: true }, { ...base, resume: { ...base.resume, path: "/tmp/resume" } }, { ...base, intent: { countries: ["IND"] } },
    { ...base, intent: { roles: ["backend", "backend"] } },
  ]) {
    await expect(recommender.recommend(input)).rejects.toEqual(expect.objectContaining({ code: "invalid_recommendation_input" }));
  }
  expect(reads).toBe(0);
  expect(crawls).toBe(0);
});

function job(id: string, description: string): Job {
  return {
    id, company: "Acme", title: "Backend Engineer", location: "Bengaluru, India", remote: false, workMode: "onsite",
    eligibleCountries: ["IN"], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit",
    url: `https://example.test/${id}`, description,
  };
}

function makeSnapshot(jobs: Job[], updatedAt = "2026-08-10T00:00:00Z"): JobSnapshot {
  return {
    version: 1, updatedAt,
    partitions: { acme: { fetchedAt: updatedAt, jobs } },
    lastCrawl: { startedAt: updatedAt, finishedAt: updatedAt, selected: 1, succeeded: 1, failed: [] },
  };
}
