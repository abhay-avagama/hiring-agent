import { expect, test } from "bun:test";
import { createMcpHandler } from "../src/mcp.ts";
import { createJobRecommender } from "../src/job-recommendations.ts";
import { createJobFitAnalyzer } from "../src/job-fit-analysis.ts";
import { createResumeOptimizer } from "../src/resume-optimization.ts";
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
  const analyzer = createJobFitAnalyzer({ getJob: async (id) => id === job.id ? job : null });
  const optimizer = createResumeOptimizer({ analyzeJobFit: analyzer.analyze });
  const handler = createMcpHandler(createToolHandler(catalog, { ...recommender, analyzeJobFit: analyzer.analyze, optimizeResume: optimizer.optimize }));
  const response = await handler({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "recommend_jobs", arguments: { resume: { content: "Skills\nJava\nExperience\nBackend Engineer — Acme", format: "text" }, intent: { countries: ["IN"] }, ranking: { mode: "keyword", minimumPercent: 80 }, refresh: { policy: "never" } } },
  });
  if (!response || !("result" in response)) throw new Error("Expected MCP result");
  const rpcResult = response.result as { content: Array<{ type: "text"; text: string }> };
  const payload = JSON.parse(rpcResult.content[0]!.text) as {
    matches: Array<{ job: { id: string }; scores: { evidence: number; keyword: number }; selectedScore: number }>;
    exploration: { directMatches: Array<{ job: { id: string } }>; hiddenMatches: unknown[]; stretchMatches: unknown[] };
    profile: { facts: unknown[] }; ranking: { mode: string; minimumPercent: number }; refresh: { policy: string };
  };
  expect(crawls).toBe(0);
  expect(payload.matches[0]!.job.id).toBe(job.id);
  expect(payload.profile.facts.length).toBeGreaterThan(0);
  expect(payload.ranking).toEqual({ mode: "keyword", minimumPercent: 80 });
  expect(payload.matches[0]!.selectedScore).toBe(payload.matches[0]!.scores.keyword);
  expect(payload.exploration.directMatches[0]!.job.id).toBe(job.id);
  expect(payload.exploration.hiddenMatches).toEqual([]);
  expect(payload.refresh.policy).toBe("never");

  const invalidCalls = [
    { arguments: { resume: { content: "Skills\nJava", format: "text" }, intent: { countries: ["IN"] }, refresh: { policy: "never" }, limit: 101 }, code: "invalid_recommendation_input" },
    { arguments: { resume: { content: "Skills\nJava", format: "text" }, intent: { countries: ["IND"] }, refresh: { policy: "never" } }, code: "invalid_recommendation_input" },
    { arguments: { resume: { content: "Skills\nJava", format: "text" }, intent: {}, unexpected: true }, code: "invalid_recommendation_input" },
    { arguments: { resume: { content: "Skills\nJava", format: "text" }, intent: {}, ranking: { mode: "popularity" } }, code: "invalid_recommendation_input" },
    { arguments: { resume: { content: "Skills\nJava", format: "text" }, intent: {}, ranking: { mode: "evidence", minimumPercent: 101 } }, code: "invalid_recommendation_input" },
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

test("analyze_job_fit runs selected-job evidence analysis through MCP without crawling", async () => {
  const job: Job = {
    id: "greenhouse:acme:2", company: "Acme", title: "Backend Engineer", location: "Bengaluru, India", remote: false, workMode: "onsite",
    eligibleCountries: ["IN"], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit", url: "https://example.test/2",
    description: "Java and AWS are required. Candidates must be authorized to work in India.",
  };
  let lookups = 0;
  const analyzer = createJobFitAnalyzer({ getJob: async (id) => { lookups += 1; return id === job.id ? job : null; } });
  const catalog: Catalog = { search: async () => [], get: async () => null };
  const optimizer = createResumeOptimizer({ analyzeJobFit: analyzer.analyze });
  const workflows = { recommend: async () => { throw new Error("recommend should not run"); }, analyzeJobFit: analyzer.analyze, optimizeResume: optimizer.optimize };
  const handler = createMcpHandler(createToolHandler(catalog, workflows));
  const response = await handler({
    jsonrpc: "2.0", id: 30, method: "tools/call",
    params: { name: "analyze_job_fit", arguments: { jobId: job.id, resume: { content: "Skills\nJava", format: "text" }, intent: { countries: ["IN"] } } },
  });
  if (!response || !("result" in response)) throw new Error("Expected MCP result");
  const result = response.result as { content: Array<{ text: string }>; isError: boolean };
  const payload = JSON.parse(result.content[0]!.text) as { supported: Array<{ requirement: string }>; unsupported: string[]; screeningRisks: string[] };
  expect(result.isError).toBe(false);
  expect(payload.supported).toContainEqual(expect.objectContaining({ requirement: "Java" }));
  expect(payload.unsupported).toEqual(expect.arrayContaining(["AWS", "Work authorization in India"]));
  expect(payload.screeningRisks).toContain("Work authorization is required but cannot be inferred from resume silence or geographic intent: India");
  expect(lookups).toBe(1);

  const missing = await handler({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "analyze_job_fit", arguments: { jobId: "missing", resume: { content: "Skills\nJava", format: "text" } } } });
  if (!missing || !("result" in missing)) throw new Error("Expected MCP tool error");
  const errorResult = missing.result as { content: Array<{ text: string }>; isError: boolean };
  expect(errorResult.isError).toBe(true);
  expect(JSON.parse(errorResult.content[0]!.text).error).toEqual(expect.objectContaining({ code: "job_not_found", field: "jobId" }));
});

test("optimize_resume returns a grounded revision through MCP without overwriting the input", async () => {
  const job: Job = {
    id: "greenhouse:acme:3", company: "Acme", title: "Backend Engineer", location: "Bengaluru, India", remote: false, workMode: "onsite",
    eligibleCountries: ["IN"], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit", url: "https://example.test/3",
    description: "Java and Kubernetes are required.",
  };
  const analyzer = createJobFitAnalyzer({ getJob: async (id) => id === job.id ? job : null });
  const optimizer = createResumeOptimizer({ analyzeJobFit: analyzer.analyze });
  const catalog: Catalog = { search: async () => [], get: async () => null };
  const workflows = { recommend: async () => { throw new Error("recommend should not run"); }, analyzeJobFit: analyzer.analyze, optimizeResume: optimizer.optimize };
  const handler = createMcpHandler(createToolHandler(catalog, workflows));
  const original = "Skills\nJava";
  const response = await handler({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "optimize_resume", arguments: { jobId: job.id, resume: { content: original, format: "text" }, output: "revised_markdown" } } });
  if (!response || !("result" in response)) throw new Error("Expected MCP result");
  const rpc = response.result as { content: Array<{ text: string }>; isError: boolean };
  const payload = JSON.parse(rpc.content[0]!.text) as { content: string; suggestions: Array<{ proposedText: string }>; gaps: string[]; originalOverwritten: boolean };
  expect(rpc.isError).toBe(false);
  expect(payload.content).toContain("- Java");
  expect(payload.content).toEndWith(original);
  expect(payload.content).not.toContain("Kubernetes");
  expect(payload.gaps).toContain("Kubernetes");
  expect(payload.originalOverwritten).toBe(false);
});
