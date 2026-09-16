import { expect, test } from "bun:test";
import { searchJobs } from "../src/catalog.ts";
import { FLOW_INSTRUCTIONS } from "../src/mcp.ts";
import { createMcpHandler } from "../src/mcp.ts";
import { createToolHandler } from "../src/tools.ts";
import type { Job } from "../src/types.ts";

const now = Date.parse("2026-09-16T12:00:00Z");
const job = (id: string, extra: Partial<Job> = {}): Job => ({
  id, company: "Example", title: "Backend Engineer", location: "India", remote: false, workMode: "onsite",
  eligibleCountries: ["IN"], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit",
  url: "https://example.test/" + id, description: "Build systems", updatedAt: "2026-09-15T12:00:00Z", ...extra,
});

test("pagination uses a stable id tie-breaker, full-window count and a terminal offset", () => {
  const jobs = ["c", "b", "a", "e", "d"].map((id) => job(id));
  const first = searchJobs(jobs, { country: "IN", limit: 2 }, now);
  expect(first.map((j) => j.id)).toEqual(["a", "b"]);
  expect(first.pagination).toEqual({ offset: 0, limit: 2, total: 5, nextOffset: 2 });
  const second = searchJobs(jobs.reverse(), { country: "IN", limit: 2, offset: 2, maxAgeDays: first.window!.daysUsed }, now);
  expect(second.map((j) => j.id)).toEqual(["c", "d"]);
  expect(searchJobs(jobs, { limit: 2, offset: 4 }, now).pagination?.nextOffset).toBeNull();
  expect(searchJobs(jobs, { offset: 100 }, now)).toHaveLength(0);
  expect(first.window?.steps[0]?.results).toBe(5);
});

test("experience uses stated ranges, respects open minima, and excludes unknown by default", () => {
  const jobs = [job("junior", { experience: { min: 0, max: 2 } }), job("mid", { experience: { min: 3, max: 5 } }), job("senior", { experience: { min: 8 } }), job("unknown"), job("parsed", { description: "Requires 3+ years of software engineering experience." }), job("intern", { title: "Engineer Intern" })];
  const strict = searchJobs(jobs, { experienceYears: 4 }, now);
  expect(strict.map((j) => j.id)).toEqual(["mid", "parsed"]);
  expect(strict.find((j) => j.id === "parsed")?.experience).toEqual({ min: 3 });
  expect(searchJobs(jobs, { experienceYears: 4, includeUnknownExperience: true }, now).map((j) => j.id)).toEqual(["intern", "mid", "parsed", "unknown"]);
  expect(searchJobs(jobs, { experienceYears: 0 }, now).map((j) => j.id)).toEqual(["junior"]);
  expect(searchJobs(jobs, { experienceYears: 12 }, now).map((j) => j.id)).toEqual(["parsed", "senior"]);
});

test("initialization instructions make resumes optional", () => {
  expect(FLOW_INSTRUCTIONS).toContain("a resume is optional");
  expect(FLOW_INSTRUCTIONS).not.toContain("Ask for the resume before");
});

test("MCP serializes pagination and validates experience filters without resume workflows", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Resume/setup workflow must not run"); };
  const tools = createToolHandler({
    search: async (query) => searchJobs([job("a", { experience: { min: 3 } }), job("b", { experience: { min: 3 } }), job("c", { experience: { min: 8 } })], query, now),
    get: async () => null,
  }, { prepareJobSearch: unexpected, getJobCoverage: unexpected, recommend: unexpected, analyzeJobFit: unexpected, optimizeResume: unexpected });
  const handler = createMcpHandler(tools);
  const response = await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_jobs", arguments: { country: "IN", experienceYears: 4, limit: 1, offset: 1, maxAgeDays: 7 } } });
  expect(response).toEqual(expect.objectContaining({ result: expect.objectContaining({
    isError: false,
    structuredContent: expect.objectContaining({ jobs: [expect.objectContaining({ id: "b", experience: { min: 3 } })], pagination: { offset: 1, limit: 1, total: 2, nextOffset: null } }),
    content: [expect.objectContaining({ text: expect.stringContaining('"total": 2') })],
  }) }));
  for (const offset of [-1, 1.5, "1", 1000001]) await expect(tools.call("search_jobs", { offset })).rejects.toThrow("offset must");
  for (const experienceYears of [-1, 61, NaN, Infinity, "4"]) await expect(tools.call("search_jobs", { experienceYears })).rejects.toThrow("experienceYears must");
  await expect(tools.call("search_jobs", { includeUnknownExperience: "true" })).rejects.toThrow("includeUnknownExperience must");
});
