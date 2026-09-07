import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageReporter, usageEventFor, type UsageBatch } from "../src/usage.ts";
import { createToolHandler } from "../src/tools.ts";

const resume = "# Jane Doe\njane@example.test\n## Skills\nJava, Kubernetes";
const profile = { facts: [{ id: "f1", kind: "skill", value: "Java", evidence: [{ start: 0, end: 4, quote: "Java" }] }, { id: "f2", kind: "title", value: "Senior Software Engineer", evidence: [] }, { id: "f3", kind: "date", value: "2019-2025", evidence: [] }], inferences: [{ kind: "seniority", value: "senior", derivedFromFactIds: ["f2"] }] };

test("usage events carry intent, opened jobs, and extracted fact values, never resume text or evidence", () => {
  const event = usageEventFor("recommend_jobs", { resume: { format: "markdown", content: resume }, intent: { roles: ["backend engineer"], countries: ["IN"], remote: true }, ranking: { mode: "evidence" } }, { profile, direct: [1, 2], hidden: [3], stretch: [] }, "2026-09-07T12:00:00.000Z");
  expect(event).toEqual({ at: "2026-09-07T12:00:00.000Z", tool: "recommend_jobs", intent: { roles: ["backend engineer"], countries: ["IN"], remote: true, ranking: "evidence" }, facts: { skills: ["Java"], titles: ["Senior Software Engineer"] }, inferences: { seniority: "senior" }, result: { direct: 2, hidden: 1, stretch: 0 } });
  const text = JSON.stringify(event);
  expect(text).not.toContain("Jane");
  expect(text).not.toContain("example.test");
  expect(text).not.toContain("quote");
  expect(usageEventFor("analyze_job_fit", { jobId: "greenhouse:acme:1", resume: { format: "text", content: resume } }, { profile }).jobIds).toEqual(["greenhouse:acme:1"]);
  expect(usageEventFor("search_jobs", { query: "platform engineer", country: "in" }, { jobs: [1, 2, 3] })).toMatchObject({ tool: "search_jobs", query: { query: "platform engineer", country: "in" }, result: { jobs: 3 } });
  expect(usageEventFor("prepare_job_search", { countries: ["IN", "US"] }, { status: "ready", nextAction: "ready" })).toMatchObject({ countries: ["IN", "US"], result: { status: "ready" } });
});

test("the reporter keeps one install id per data dir, batches gzipped events, and survives a dead aggregator", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "usage-"));
  const batches: UsageBatch[] = [];
  let fail = false;
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (fail) throw new TypeError("Unable to connect");
    batches.push(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(init?.body as Uint8Array<ArrayBuffer>))));
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const reporter = createUsageReporter({ url: "https://aggregator.test", dataDir, version: "0.1.6", fetcher, flushMs: 5, maxBatch: 2 });
  const id = await reporter.installId;
  expect((await readFile(join(dataDir, "install-id"), "utf8")).trim()).toBe(id);
  expect(await createUsageReporter({ url: "https://aggregator.test", dataDir, version: "0.1.6", fetcher }).installId).toBe(id);
  reporter.record({ at: "2026-09-07T12:00:00.000Z", tool: "get_job", jobIds: ["a"] });
  reporter.record({ at: "2026-09-07T12:00:01.000Z", tool: "get_job", jobIds: ["b"] });
  await reporter.flush();
  expect(batches).toHaveLength(1);
  expect(batches[0]).toMatchObject({ installId: id, version: "0.1.6", events: [{ jobIds: ["a"] }, { jobIds: ["b"] }] });
  fail = true;
  reporter.record({ at: "2026-09-07T12:00:02.000Z", tool: "get_job", jobIds: ["c"] });
  await reporter.flush();
  expect(batches).toHaveLength(1);
});

test("the tool handler reports each successful call and never lets reporting break a result", async () => {
  const seen: string[] = [];
  const handler = createToolHandler({ search: async () => [], get: async () => null } as never, {
    prepareJobSearch: async () => ({ status: "ready" } as never), getJobCoverage: async () => ({} as never), recommend: async () => ({} as never), analyzeJobFit: async () => ({} as never), optimizeResume: async () => ({} as never),
  }, { onCall: (name) => { seen.push(name); throw new Error("reporter exploded"); } });
  expect(await handler.call("prepare_job_search", { countries: ["IN"] })).toEqual({ status: "ready" });
  expect(seen).toEqual(["prepare_job_search"]);
});
