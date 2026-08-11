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
    const tools = createToolHandler(catalog, {
      recommend: async (input) => {
        recommendationInput = input;
        return { matches: [] } as unknown as RecommendJobsResult;
      },
      analyzeJobFit: async () => ({ job: { id: "job" } }) as never,
    });

    expect(tools.list().map((tool) => tool.name)).toEqual(["recommend_jobs", "analyze_job_fit", "search_jobs", "get_job"]);
    expect(tools.list()[0]!.inputSchema).toEqual(expect.objectContaining({ required: ["resume", "intent"], additionalProperties: false }));
    expect(await tools.call("search_jobs", { query: "Engineer", country: "de", remote: true })).toEqual({
      jobs: [expect.objectContaining({ title: "Engineer" })],
    });
    expect(receivedCountry).toBe("DE");
    expect(await tools.call("recommend_jobs", {
      resume: { content: "Skills\nJava", format: "text" }, intent: { countries: ["IN"], excludedRoles: ["manager"] }, refresh: { policy: "never" },
    })).toEqual(expect.objectContaining({ matches: [] }));
    expect(recommendationInput).toEqual(expect.objectContaining({ intent: expect.objectContaining({ excludedRoles: ["manager"] }), refresh: { policy: "never" } }));
    expect(await tools.call("analyze_job_fit", { jobId: "job", resume: { content: "Skills\nJava", format: "text" } })).toEqual(expect.objectContaining({ job: expect.objectContaining({ id: "job" }) }));
    await expect(tools.call("search_jobs", { remote: "true" })).rejects.toThrow("remote must be a boolean");
    await expect(tools.call("search_jobs", { limit: 101 })).rejects.toThrow("limit must be an integer between 1 and 100");
    await expect(tools.call("get_job", { id: "job", extra: true })).rejects.toThrow("get_job does not accept field: extra");
    expect(() => tools.call("apply_to_job", {})).toThrow("Unknown tool");
  });
});
