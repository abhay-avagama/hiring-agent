import { expect, test } from "bun:test";
import { createMcpHandler } from "../src/mcp.ts";

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
