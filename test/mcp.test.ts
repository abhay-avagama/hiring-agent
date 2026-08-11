import { expect, test } from "bun:test";
import { createMcpHandler } from "../src/mcp.ts";
import { createJobRecommender } from "../src/job-recommendations.ts";
import { createToolHandler } from "../src/tools.ts";
import type { Catalog } from "../src/catalog.ts";
import type { Company, Job, JobSnapshot } from "../src/types.ts";

test("MCP lists and calls the read-only jobs tools", async () => {
  const handler = createMcpHandler({
    list: () => [{ name: "search_jobs", description: "Search", inputSchema: { type: "object" } }],
    call: async () => ({ jobs: [{ id: "ashby:acme:1" }] }),
  });

  expect(await handler({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toEqual(expect.objectContaining({
    id: 1, result: { tools: [expect.objectContaining({ name: "search_jobs" })] },
  }));
  expect(await handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_jobs", arguments: {} } })).toEqual(expect.objectContaining({
    result: { content: [expect.objectContaining({ type: "text" })], isError: false },
  }));
});

test("MCP preserves stable tool validation details", async () => {
  const handler = createMcpHandler({
    list: () => [],
    call: async () => { throw Object.assign(new Error("Unknown refresh policy"), { code: "invalid_recommendation_input", field: "refresh.policy" }); },
  });
  const response = await handler({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recommend_jobs", arguments: {} } });
  expect(response).toEqual(expect.objectContaining({ jsonrpc: "2.0", id: 3, result: expect.objectContaining({ isError: true }) }));
  if (!response || !("result" in response)) throw new Error("Expected tool error result");
  const rpcResult = response.result as { content: Array<{ text: string }>; isError: boolean };
  expect(JSON.parse(rpcResult.content[0]!.text)).toEqual({ error: { message: "Unknown refresh policy", code: "invalid_recommendation_input", field: "refresh.policy" } });
});

test("MCP rejects malformed arguments and ignores id-less calls before tool execution", async () => {
  let calls = 0;
  const handler = createMcpHandler({ list: () => [], call: async () => { calls += 1; return {}; } });
  expect(await handler({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "search_jobs", arguments: [] as never } })).toEqual({
    jsonrpc: "2.0", id: 5, error: { code: -32602, message: "tools/call arguments must be an object" },
  });
  expect(await handler({ jsonrpc: "2.0", method: "tools/call", params: { name: "recommend_jobs", arguments: {} } })).toBeNull();
  expect(calls).toBe(0);
});

test("MCP distinguishes invalid JSON-RPC envelopes from valid notifications", async () => {
  const handler = createMcpHandler({ list: () => [], call: async () => ({}) });
  for (const [value, id] of [[null, null], [42, null], [{ jsonrpc: "2.0", id: 7 }, 7], [{ jsonrpc: "1.0", id: 8, method: "ping" }, 8]] as const) {
    expect(await handler(value)).toEqual({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } });
  }
  expect(await handler({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
});

test("recommend_jobs runs parsing and matching through MCP while refresh never performs no crawl", async () => {
  const source: Company = { slug: "acme", name: "Acme", ats: "greenhouse", token: "acme", cohorts: ["IN"] };
  const job: Job = {
    id: "greenhouse:acme:1", company: "Acme", title: "Backend Engineer", location: "Bengaluru, India", remote: false, workMode: "onsite",
    eligibleCountries: ["IN"], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit", url: "https://example.test/1",
    description: "Java is required.",
  };
  const snapshot: JobSnapshot = {
    version: 1, updatedAt: "2026-01-01T00:00:00Z", partitions: { acme: { fetchedAt: "2026-01-01T00:00:00Z", jobs: [job] } },
    lastCrawl: { startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:00Z", selected: 1, succeeded: 1, failed: [] },
  };
  let crawls = 0;
  const recommender = createJobRecommender({
    sources: [source], store: { read: async () => snapshot, write: async () => undefined },
    crawl: async () => { crawls += 1; return snapshot.lastCrawl; }, now: () => new Date("2026-08-11T00:00:00Z"),
  });
  const catalog: Catalog = { search: async () => [], get: async () => null };
  const handler = createMcpHandler(createToolHandler(catalog, recommender));
  const response = await handler({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "recommend_jobs", arguments: { resume: { content: "Skills\nJava", format: "text" }, intent: { countries: ["IN"] }, refresh: { policy: "never" } } },
  });
  if (!response || !("result" in response)) throw new Error("Expected MCP result");
  const rpcResult = response.result as { content: Array<{ type: "text"; text: string }> };
  const payload = JSON.parse(rpcResult.content[0]!.text) as { matches: Array<{ job: { id: string } }>; profile: { facts: unknown[] }; refresh: { policy: string } };
  expect(crawls).toBe(0);
  expect(payload.matches[0]!.job.id).toBe(job.id);
  expect(payload.profile.facts.length).toBeGreaterThan(0);
  expect(payload.refresh.policy).toBe("never");

  const invalidCalls = [
    { arguments: { resume: { content: "Skills\nJava", format: "text" }, intent: { countries: ["IN"] }, refresh: { policy: "never" }, limit: 101 }, code: "invalid_recommendation_input" },
    { arguments: { resume: { content: "Skills\nJava", format: "text" }, intent: { countries: ["IND"] }, refresh: { policy: "never" } }, code: "invalid_recommendation_input" },
    { arguments: { resume: { content: "Skills\nJava", format: "text" }, intent: {}, unexpected: true }, code: "invalid_recommendation_input" },
    { arguments: { resume: { content: "encoded", format: "pdf_base64" }, intent: {}, refresh: { policy: "never" } }, code: "unsupported_resume_format" },
  ];
  for (const [index, invalid] of invalidCalls.entries()) {
    const invalidResponse = await handler({ jsonrpc: "2.0", id: 10 + index, method: "tools/call", params: { name: "recommend_jobs", arguments: invalid.arguments } });
    if (!invalidResponse || !("result" in invalidResponse)) throw new Error("Expected MCP tool error");
    const invalidResult = invalidResponse.result as { content: Array<{ text: string }>; isError: boolean };
    expect(invalidResult.isError).toBe(true);
    expect(JSON.parse(invalidResult.content[0]!.text).error.code).toBe(invalid.code);
  }
  expect(crawls).toBe(0);
});
