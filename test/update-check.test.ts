import { expect, test } from "bun:test";
import { createMcpHandler } from "../src/mcp.ts";
import { isNewer, startUpdateCheck, updateNotice } from "../src/update-check.ts";

test("update check compares versions numerically and survives a dead registry", async () => {
  expect(isNewer("0.1.18", "0.1.17")).toBe(true);
  expect(isNewer("0.1.9", "0.1.17")).toBe(false);
  expect(isNewer("0.1.17", "0.1.17")).toBe(false);
  expect(isNewer("1.0.0", "0.9.9")).toBe(true);
  const newer = startUpdateCheck({ current: "0.1.17", fetcher: (async () => Response.json({ version: "0.1.18" })) });
  await newer.ready;
  expect(newer.get()).toEqual(expect.objectContaining({ installed: "0.1.17", latest: "0.1.18", run: "bun add --global openings" }));
  const same = startUpdateCheck({ current: "0.1.18", fetcher: (async () => Response.json({ version: "0.1.18" })) });
  await same.ready;
  expect(same.get()).toBeNull();
  const dead = startUpdateCheck({ current: "0.1.17", fetcher: (async () => { throw new Error("offline"); }) });
  await dead.ready;
  expect(dead.get()).toBeNull();
  const off = startUpdateCheck({ current: "0.1.17", enabled: false, fetcher: (async () => Response.json({ version: "9.9.9" })) });
  await off.ready;
  expect(off.get()).toBeNull();
});

test("a pending update rides on initialize and on every tool result, success or error", async () => {
  const notice = updateNotice("0.1.17", "0.1.18");
  const handler = createMcpHandler({
    list: () => [],
    call: async (name) => { if (name === "boom") throw new Error("nope"); return { jobs: [] }; },
  }, { update: () => notice });
  const init = await handler({ jsonrpc: "2.0", id: 1, method: "initialize" }) as { result: { instructions?: string } };
  expect(init.result.instructions).toContain("bun add --global openings");
  expect(init.result.instructions).toContain("Ask for the resume");
  const ok = await handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_jobs", arguments: {} } }) as { result: { content: Array<{ text: string }> } };
  expect(JSON.parse(ok.result.content[0]!.text)).toEqual({ jobs: [], updateAvailable: notice });
  const failed = await handler({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "boom", arguments: {} } }) as { result: { content: Array<{ text: string }>; isError: boolean } };
  expect(failed.result.isError).toBe(true);
  expect(JSON.parse(failed.result.content[0]!.text).updateAvailable).toEqual(notice);
  const quiet = createMcpHandler({ list: () => [], call: async () => ({ jobs: [] }) });
  const plain = await quiet({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_jobs", arguments: {} } }) as { result: { content: Array<{ text: string }> } };
  expect(JSON.parse(plain.result.content[0]!.text)).toEqual({ jobs: [] });
});
