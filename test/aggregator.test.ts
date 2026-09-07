import { expect, test } from "bun:test";
import { createAggregator } from "../server/aggregator.ts";
import type { Company, Job, JobSnapshot } from "../src/types.ts";

const sources: Company[] = [
  { slug: "acme", name: "Acme", ats: "greenhouse", token: "acme" },
  { slug: "globex", name: "Globex", ats: "recruitee", token: "globex", companyDomain: "globex.test" },
];
const job = (id: string, title: string, url: string, extra: Partial<Job> = {}): Job => ({
  id, company: "Acme", title, location: "Bengaluru, India", remote: false, workMode: "onsite",
  eligibleCountries: ["IN"], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit", url, description: "Build systems.", ...extra,
});
const post = (aggregator: ReturnType<typeof createAggregator>, payload: unknown, gzip = true) => aggregator.fetch(new Request("http://aggregator.test/v1/crawls", {
  method: "POST",
  headers: gzip ? { "content-type": "application/json", "content-encoding": "gzip" } : { "content-type": "application/json" },
  body: gzip ? Bun.gzipSync(JSON.stringify(payload)) : JSON.stringify(payload),
}));

test("aggregator accepts verified-source reports, drops untrusted jobs, and publishes the latest partition per source", async () => {
  let clock = new Date("2026-09-07T10:00:00.000Z");
  const aggregator = createAggregator({ sources, now: () => clock });
  const first = await post(aggregator, { version: 1, source: { slug: "acme", ats: "greenhouse", token: "acme" }, fetchedAt: "2026-09-06T09:00:00.000Z", jobs: [
    job("greenhouse:acme:1", "Engineer", "https://job-boards.greenhouse.io/acme/jobs/1"),
    job("greenhouse:acme:2", "Analyst", "https://boards.greenhouse.io/acme/jobs/2"),
    job("greenhouse:acme:3", "", "https://boards.greenhouse.io/acme/jobs/3"),
    job("greenhouse:acme:4", "Phisher", "https://evil.test/acme/jobs/4"),
    job("lever:acme:5", "Wrong prefix", "https://boards.greenhouse.io/acme/jobs/5"),
  ] });
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ accepted: 2, created: 2, rejected: 3 });

  const unknown = await post(aggregator, { version: 1, source: { slug: "initech", ats: "lever", token: "initech" }, fetchedAt: "2026-09-06T09:00:00.000Z", jobs: [] });
  expect(unknown.status).toBe(400);
  const mismatch = await post(aggregator, { version: 1, source: { slug: "acme", ats: "lever", token: "acme" }, fetchedAt: "2026-09-06T09:00:00.000Z", jobs: [] }, false);
  expect(mismatch.status).toBe(400);

  clock = new Date("2026-09-07T12:00:00.000Z");
  const second = await post(aggregator, { version: 1, source: { slug: "acme", ats: "greenhouse", token: "acme" }, fetchedAt: "2026-09-07T11:00:00.000Z", jobs: [
    job("greenhouse:acme:1", "Engineer", "https://job-boards.greenhouse.io/acme/jobs/1"),
    job("greenhouse:acme:6", "Platform Lead", "https://job-boards.greenhouse.io/acme/jobs/6"),
  ] });
  expect(await second.json()).toEqual({ accepted: 2, created: 1, rejected: 0 });
  await post(aggregator, { version: 1, source: { slug: "globex", ats: "recruitee", token: "globex" }, fetchedAt: "2026-09-07T11:30:00.000Z", jobs: [
    job("recruitee:globex:9", "Designer", "https://careers.globex.test/o/designer", { company: "Globex", eligibilityConfidence: "unknown" }),
  ] });

  const snapshot = await (await aggregator.fetch(new Request("http://aggregator.test/v1/snapshot"))).json() as JobSnapshot;
  expect(snapshot.version).toBe(1);
  expect(Object.keys(snapshot.partitions).sort()).toEqual(["acme", "globex"]);
  expect(snapshot.partitions.acme?.fetchedAt).toBe("2026-09-07T11:00:00.000Z");
  expect(snapshot.partitions.acme?.jobs.map((entry) => entry.id)).toEqual(["greenhouse:acme:1", "greenhouse:acme:6"]);
  expect(snapshot.partitions.globex?.jobs).toHaveLength(1);

  const compressed = await aggregator.fetch(new Request("http://aggregator.test/v1/snapshot", { headers: { "accept-encoding": "gzip" } }));
  expect(compressed.headers.get("content-encoding")).toBe("gzip");
  expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await compressed.arrayBuffer())))).version).toBe(1);

  const digest = await (await aggregator.fetch(new Request("http://aggregator.test/v1/digest?days=1&country=in"))).text();
  expect(digest).toContain("**Platform Lead** at Acme");
  expect(digest).not.toContain("Engineer");
  expect(digest).not.toContain("Designer");

  const health = await (await aggregator.fetch(new Request("http://aggregator.test/healthz"))).json();
  expect(health).toEqual({ ok: true, jobs: 4, sources: 2 });
});

test("aggregator rejects malformed, stale, and oversized reports", async () => {
  const aggregator = createAggregator({ sources, now: () => new Date("2026-09-07T10:00:00.000Z") });
  expect((await post(aggregator, { version: 2 })).status).toBe(400);
  expect((await post(aggregator, { version: 1, source: { slug: "acme", ats: "greenhouse", token: "acme" }, fetchedAt: "2026-01-01T00:00:00.000Z", jobs: [] })).status).toBe(400);
  const notJson = await aggregator.fetch(new Request("http://aggregator.test/v1/crawls", { method: "POST", body: "nope" }));
  expect(notJson.status).toBe(400);
  const huge = await aggregator.fetch(new Request("http://aggregator.test/v1/crawls", { method: "POST", headers: { "content-length": String(65 * 1024 * 1024) }, body: "{}" }));
  expect(huge.status).toBe(413);
  expect((await aggregator.fetch(new Request("http://aggregator.test/v1/digest?country=india"))).status).toBe(400);
});
