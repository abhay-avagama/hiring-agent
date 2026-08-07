import { describe, expect, test } from "bun:test";
import { createToolHandler } from "../src/tools.ts";
import type { Catalog } from "../src/catalog.ts";

describe("agent tools", () => {
  test("exposes only read-only search and get operations", async () => {
    const catalog: Catalog = {
      search: async (query) => [{ id: "lever:acme:1", company: "Acme", title: String(query.query), location: "Remote", remote: true, url: "https://example.test/1" }],
      get: async () => null,
    };
    const tools = createToolHandler(catalog);

    expect(tools.list().map((tool) => tool.name)).toEqual(["search_jobs", "get_job"]);
    expect(await tools.call("search_jobs", { query: "Engineer", remote: true })).toEqual({
      jobs: [expect.objectContaining({ title: "Engineer" })],
    });
    expect(() => tools.call("apply_to_job", {})).toThrow("Unknown tool");
  });
});
