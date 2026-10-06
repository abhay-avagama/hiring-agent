import { expect, test } from "bun:test";
import { createToolHandler, SCOPES, scopeForTool } from "../src/tools.ts";

const stub = new Proxy({}, { get: () => async () => ({ ok: true }) }) as never;
const handler = (scopes?: readonly string[]) => createToolHandler(stub, stub, scopes === undefined ? {} : { scopes });

test("a token with no scopes keeps every tool, so nothing issued before the split breaks", () => {
  // 78 refresh tokens were live when this shipped. A token that states no scopes is held to none.
  expect(handler().list().map((t) => t.name).sort()).toEqual(
    ["analyze_job_fit", "get_job", "get_job_coverage", "optimize_resume", "prepare_job_search", "recommend_jobs", "search_jobs"]);
});

test("a job-search token never sees the tools that read a resume", () => {
  const names = handler([SCOPES.jobs]).list().map((t) => t.name).sort();
  expect(names).toEqual(["get_job", "get_job_coverage", "prepare_job_search", "search_jobs"]);
  expect(names).not.toContain("recommend_jobs");
});

test("calling a tool outside the grant is refused by name, not by silence", async () => {
  await expect(handler([SCOPES.jobs]).call("optimize_resume", {})).rejects.toThrow("resume.analyze");
  // and the tools it was granted still work
  await expect(handler([SCOPES.jobs]).call("get_job_coverage", { countries: ["IN"] })).resolves.toBeDefined();
});

test("a resume token carries the resume tools and not the rest", () => {
  expect(handler([SCOPES.resume]).list().map((t) => t.name).sort())
    .toEqual(["analyze_job_fit", "optimize_resume", "recommend_jobs"]);
});

test("every tool is mapped to exactly one scope", () => {
  for (const tool of handler().list()) expect([tool.name, scopeForTool(tool.name)]).toEqual([tool.name, expect.any(String)]);
  expect(scopeForTool("not_a_tool")).toBeUndefined();
});
