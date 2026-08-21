import { describe, expect, test } from "bun:test";
import { createToolHandler } from "../src/tools.ts";
import type { Catalog } from "../src/catalog.ts";
import type { RecommendJobsResult } from "../src/job-recommendations.ts";

describe("agent tools", () => {
  test("exposes only read-only recommendation, search, and get operations", async () => {
    let receivedCountry: string | undefined;
    const catalog: Catalog = {
      search: async (query) => {
        receivedCountry = query.country;
        return [{ id: "lever:acme:1", company: "Acme", title: String(query.query), location: "Remote", remote: true, workMode: "remote", eligibleCountries: ["IN"], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit", url: "https://example.test/1" }];
      },
      get: async () => null,
    };
    let recommendationInput: unknown;
    let coverageInput: unknown;
    const tools = createToolHandler(catalog, {
      getJobCoverage: async (input) => {
        coverageInput = input;
        return { snapshotUpdatedAt: "2026-08-21T00:00:00.000Z", countries: [{ country: "IN", indexedSourcesWithEligibleJobs: 2, eligibleJobs: 20, distinctEligibleEmployers: 2 }] };
      },
      recommend: async (input) => {
        recommendationInput = input;
        return { matches: [] } as unknown as RecommendJobsResult;
      },
      analyzeJobFit: async () => ({ job: { id: "job" } }) as never,
      optimizeResume: async () => ({ output: "suggestions", suggestions: [] }) as never,
    });

    expect(tools.list().map((tool) => tool.name)).toEqual(["get_job_coverage", "recommend_jobs", "analyze_job_fit", "optimize_resume", "search_jobs", "get_job"]);
    expect(await tools.call("get_job_coverage", { countries: ["in"] })).toEqual(expect.objectContaining({
      countries: [{ country: "IN", indexedSourcesWithEligibleJobs: 2, eligibleJobs: 20, distinctEligibleEmployers: 2 }],
    }));
    expect(coverageInput).toEqual({ countries: ["in"] });
    expect(tools.list()[1]!.inputSchema).toEqual(expect.objectContaining({ required: ["resume", "intent"], additionalProperties: false }));
    expect(await tools.call("search_jobs", { query: "Engineer", country: "de", remote: true })).toEqual({
      jobs: [expect.objectContaining({ title: "Engineer" })],
    });
    expect(receivedCountry).toBe("DE");
    expect(await tools.call("recommend_jobs", {
      resume: { content: "Skills\nJava", format: "text" }, intent: { countries: ["IN"], excludedRoles: ["manager"] }, refresh: { policy: "never" },
    })).toEqual(expect.objectContaining({ matches: [] }));
    expect(recommendationInput).toEqual(expect.objectContaining({ intent: expect.objectContaining({ excludedRoles: ["manager"] }), refresh: { policy: "never" } }));
    expect(await tools.call("analyze_job_fit", { jobId: "job", resume: { content: "Skills\nJava", format: "text" } })).toEqual(expect.objectContaining({ job: expect.objectContaining({ id: "job" }) }));
    expect(await tools.call("optimize_resume", { jobId: "job", resume: { content: "Skills\nJava", format: "text" }, output: "suggestions" })).toEqual(expect.objectContaining({ suggestions: [] }));
    await expect(tools.call("search_jobs", { remote: "true" })).rejects.toThrow("remote must be a boolean");
    await expect(tools.call("search_jobs", { limit: 101 })).rejects.toThrow("limit must be an integer between 1 and 100");
    await expect(tools.call("get_job", { id: "job", extra: true })).rejects.toThrow("get_job does not accept field: extra");
    expect(() => tools.call("apply_to_job", {})).toThrow("Unknown tool");
  });
});
