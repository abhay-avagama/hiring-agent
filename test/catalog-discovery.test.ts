import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCatalog } from "../src/catalog-discovery.ts";
import { readEnrichmentRegistry } from "../src/enrichment-registry.ts";

async function statePath() { return join(await mkdtemp(join(tmpdir(), "catalog-discovery-")), ".openings", "campaign.sqlite"); }
const indexes = ["CC-MAIN-2026-30", "CC-MAIN-2026-34"];
test("temporary gateway failures retry the same page and count every request", async () => {
  const state = await statePath(); let tries = 0, time = 0; const delays: number[] = [];
  const result = await discoverCatalog({ state, indexes: [indexes[0]!], providers: ["lever"], execute: true }, {
    now: () => time, sleep: async ms => { delays.push(ms); time += ms; }, fetch: async input => {
      const u = new URL(input);
      if (u.searchParams.has("showNumPages")) return Response.json({ pages: 1, pageSize: 1 });
      expect(u.searchParams.get("page")).toBe("0");
      if (++tries <= 2) return new Response("upstream timed out", { status: 504, headers: { server: "gateway-test", "set-cookie": "private" } });
      return new Response(JSON.stringify({ url: "https://jobs.lever.co/acme/1" }));
    },
  });
  expect(result.status).toBe("complete"); expect(result.requestsThisRun).toBe(4); expect(result.boards).toBe(1);
  expect(delays.some(ms=>ms>=10000)).toBe(true); expect(delays.some(ms=>ms>=20000)).toBe(true);
  expect(result.lastFailure?.headers).toEqual({ server: "gateway-test" });
  expect(result.lastFailure?.bodyPreview).toBe("upstream timed out");
});
test("gateway retry allowance survives request-budget restarts and retains bounded diagnostics", async () => {
  const state = await statePath(); let time = 0;
  const options = { state, indexes: [indexes[0]!], providers: ["lever" as const], execute: true, requestBudget: 1 };
  const deps = { now: () => time, sleep: async (ms: number) => { time += ms; }, fetch: async () => new Response("x".repeat(5000), { status: 502 }) };
  expect((await discoverCatalog(options, deps)).status).toBe("request_budget");
  expect((await discoverCatalog(options, deps)).status).toBe("request_budget");
  const failed = await discoverCatalog(options, deps);
  expect(failed.status).toBe("error"); expect(failed.requestsTotal).toBe(3);
  expect(failed.queries[0]?.pages).toBeNull(); expect(failed.queries[0]?.next_page).toBe(0);
  expect(failed.lastFailure?.bodyPreview.length).toBe(2048);
  expect((await discoverCatalog(options, deps)).requestsThisRun).toBe(0);
});
test("long gateway Retry-After yields without another request and 503 never retries", async () => {
  for (const status of [504, 503]) {
    const state = await statePath(); let time = 0, calls = 0;
    const options = { state, indexes: [indexes[0]!], providers: ["lever" as const], execute: true };
    const deps = { now: () => time, sleep: async (ms: number) => { time += ms; }, fetch: async () => {
      calls++; return new Response("busy", { status, headers: { "retry-after": "3600" } });
    } };
    expect((await discoverCatalog(options, deps)).status).toBe(status === 503 ? "throttled" : "cooling_down");
    expect((await discoverCatalog(options, deps)).status).toBe("cooling_down");
    expect(calls).toBe(1);
  }
});
test("catalog discovery walks complete CDX pages and deduplicates boards across pinned indexes", async () => {
  const state = await statePath(); const calls: URL[] = [];
  const report = await discoverCatalog({ state, indexes, providers: ["lever"], execute: true, delayMs: 1000 }, {
    sleep: async () => {}, fetch: async input => {
      const url = new URL(String(input)); calls.push(url);
      expect(url.hostname).toBe("index.commoncrawl.org");
      expect(url.searchParams.get("pageSize")).toBe("1");
      expect(url.searchParams.has("limit")).toBe(false);
      if (url.searchParams.has("showNumPages")) return Response.json({ pages: 2, pageSize: 1, blocks: 2 });
      const token = url.searchParams.get("page") === "0" ? "acme" : "beta";
      return new Response(JSON.stringify({ url: `https://jobs.lever.co/${token}/123` }));
    },
  });
  expect(report.status).toBe("complete");
  expect(report.boards).toBe(2);
  expect(report.records).toBe(4);
  expect(calls).toHaveLength(6);
  const again = await discoverCatalog({ state, indexes, providers: ["lever"], execute: true }, { fetch: async () => { throw Error("must not refetch completed pages"); } });
  expect(again.boards).toBe(2);
  expect(again.requestsThisRun).toBe(0);
});

test("request budgets checkpoint progress and resume without losing empty or later pages", async () => {
  const state = await statePath(); const seen: string[] = [];
  const options = { state, indexes: [indexes[0]!], providers: ["lever" as const], execute: true, requestBudget: 2 };
  const deps = { sleep: async () => {}, fetch: async (input: string | URL) => {
    const url = new URL(input); seen.push(url.searchParams.get("page") ?? "count");
    if (url.searchParams.has("showNumPages")) return Response.json({ pages: 3, pageSize: 1 });
    return new Response(url.searchParams.get("page") === "1" ? "" : JSON.stringify({ url: `https://jobs.lever.co/board${url.searchParams.get("page")}/123` }));
  } };
  expect((await discoverCatalog(options, deps)).status).toBe("request_budget");
  const result = await discoverCatalog(options, deps);
  expect(result.status).toBe("complete"); expect(result.boards).toBe(2);
  expect(seen).toEqual(["count", "0", "1", "2"]);
});

test("planning makes no requests and export retains provenance without asserting identity", async () => {
  const state = await statePath(); const exportPath = state.replace("campaign.sqlite", "leads.json");
  const options = { state, indexes, providers: ["lever" as const] };
  expect((await discoverCatalog(options, { fetch: async () => { throw Error("no request permitted"); } })).status).toBe("plan");
  await discoverCatalog({ ...options, execute: true, exportPath }, { sleep: async () => {}, fetch: async input => {
    const u = new URL(input);
    return u.searchParams.has("showNumPages") ? Response.json({ pages: 1, pageSize: 1 }) : new Response(JSON.stringify({ url: "https://jobs.lever.co/acme/123" }));
  } });
  const registry = await readEnrichmentRegistry(exportPath);
  expect(registry.leads).toHaveLength(1);
  expect(registry.leads[0]).toEqual(expect.objectContaining({ sourceKey: "lever:acme", identityEvidence: [], companyMatches: [], attempts: [], discoveredFrom: indexes.map(id => ({ channel: "dataset", reference: `https://index.commoncrawl.org/${id}-index` })) }));
});

test("429 stops immediately, preserves Retry-After across restarts, and retries the same page", async () => {
  const state = await statePath(); let time = Date.parse("2026-09-16T00:00:00Z"); let calls = 0;
  const options = { state, indexes: [indexes[0]!], providers: ["lever" as const], execute: true };
  const deps = { sleep: async () => {}, now: () => time, fetch: async (input: string | URL) => {
    calls++; const u = new URL(input);
    if (u.searchParams.has("showNumPages")) return Response.json({ pages: 1, pageSize: 1 });
    if (calls === 2) return new Response("slow down", { status: 429, headers: { "retry-after": "3600" } });
    expect(u.searchParams.get("page")).toBe("0");
    return new Response(JSON.stringify({ url: "https://jobs.lever.co/acme/123" }));
  } };
  const stopped = await discoverCatalog(options, deps);
  expect(stopped.status).toBe("throttled"); expect(stopped.boards).toBe(0);
  expect((await discoverCatalog(options, deps)).status).toBe("cooling_down"); expect(calls).toBe(2);
  time += 3600000;
  expect((await discoverCatalog(options, deps)).boards).toBe(1); expect(calls).toBe(3);
});

test("a malformed page cannot partially commit boards or advance the checkpoint", async () => {
  const state = await statePath(); let broken = true;
  const options = { state, indexes: [indexes[0]!], providers: ["lever" as const], execute: true };
  const deps = { sleep: async () => {}, fetch: async (input: string | URL) => {
    const u = new URL(input);
    if (u.searchParams.has("showNumPages")) return Response.json({ pages: 1, pageSize: 1 });
    return new Response(JSON.stringify({ url: "https://jobs.lever.co/acme/123" }) + (broken ? "\ninvalid json" : ""));
  } };
  const result = await discoverCatalog(options, deps);
  expect(result.status).toBe("error"); expect(result.records).toBe(0); expect(result.boards).toBe(0);
  expect(result.queries[0]?.next_page).toBe(0);
  broken = false;
  expect((await discoverCatalog(options, deps)).boards).toBe(1);
  await expect(discoverCatalog({ ...options, indexes: [indexes[1]!] }, deps)).rejects.toThrow("configuration differs");
});

test("export refuses to overwrite existing verification outcomes", async () => {
  const state = await statePath(); const exportPath = state.replace("campaign.sqlite", "leads.json");
  await discoverCatalog({ state, indexes, providers: ["lever"] });
  await writeFile(exportPath, "preserved verification outcomes");
  await expect(discoverCatalog({ state, indexes, providers: ["lever"], exportPath })).rejects.toThrow("already exists");
  expect(await Bun.file(exportPath).text()).toBe("preserved verification outcomes");
});

test("a 50000-board campaign is not truncated at the old 10000-record limit", async () => {
  const state = await statePath();
  const report = await discoverCatalog({ state, indexes: [indexes[0]!], providers: ["lever"], execute: true }, {
    sleep: async () => {}, fetch: async input => {
      const u = new URL(input);
      if (u.searchParams.has("showNumPages")) return Response.json({ pages: 2, pageSize: 1 });
      const start = Number(u.searchParams.get("page")) * 25000;
      return new Response(Array.from({ length: 25000 }, (_, n) => JSON.stringify({ url: `https://jobs.lever.co/company-${start+n}/job` })).join("\n"));
    },
  });
  expect(report.status).toBe("complete"); expect(report.boards).toBe(50000); expect(report.records).toBe(50000);
}, 20000);

test("oversized responses fail closed and leave the page available for retry", async () => {
  const state = await statePath();
  const report = await discoverCatalog({ state, indexes: [indexes[0]!], providers: ["lever"], execute: true }, {
    sleep: async () => {}, fetch: async input => new URL(input).searchParams.has("showNumPages")
      ? Response.json({ pages: 1, pageSize: 1 }) : new Response("x".repeat(8*1024*1024+1)),
  });
  expect(report.status).toBe("error"); expect(report.error).toContain("byte limit"); expect(report.boards).toBe(0); expect(report.queries[0]?.next_page).toBe(0);
});

test("known catalog boards are reported but excluded from the isolated verification export", async () => {
  const state = await statePath();
  await discoverCatalog({ state, indexes, providers: ["lever"] });
  const catalogPath = state.replace("campaign.sqlite", "catalog.json");
  const exportPath = state.replace("campaign.sqlite", "new-leads.json");
  await writeFile(catalogPath, JSON.stringify({ acme: { ats: "lever", token: "acme" } }));
  const before = await Bun.file(catalogPath).text();
  const report = await discoverCatalog({ state, indexes, providers: ["lever"], catalogPath, exportPath, execute: true }, {
    sleep: async () => {}, fetch: async input => new URL(input).searchParams.has("showNumPages")
      ? Response.json({ pages: 1, pageSize: 1 }) : new Response(["acme", "beta"].map(t => JSON.stringify({ url: `https://jobs.lever.co/${t}/job` })).join("\n")),
  });
  expect(report.knownBoards).toBe(1); expect(report.newBoardLeads).toBe(1); expect(report.exported).toBe(1);
  expect((await readEnrichmentRegistry(exportPath)).leads.map(l=>l.token)).toEqual(["beta"]);
  expect(await Bun.file(catalogPath).text()).toBe(before);
});

test("documented no-captures results advance empty pages but generic 404s never do", async () => {
  const state = await statePath(); let missing = true;
  const options = { state, indexes: [indexes[0]!], providers: ["lever" as const], execute: true };
  const deps = { sleep: async () => {}, fetch: async (input: string | URL) => {
    const u = new URL(input);
    if (u.searchParams.has("showNumPages")) return Response.json({ pages: 2, pageSize: 1 });
    if (u.searchParams.get("page") === "0") return Response.json({ message: missing ? "Not Found" : `No Captures found for: ${u.searchParams.get("url")}` }, { status: 404 });
    return new Response(JSON.stringify({ url: "https://jobs.lever.co/acme/123" }));
  } };
  expect((await discoverCatalog(options, deps)).status).toBe("error");
  missing = false;
  const result = await discoverCatalog(options, deps);
  expect(result.status).toBe("complete"); expect(result.boards).toBe(1); expect(result.queries[0]?.next_page).toBe(2);
});

test("checkpoint names cannot alias an export lock or temporary artifact", async () => {
  const state = (await statePath()).replace("campaign.sqlite", "leads.json.lock");
  await expect(discoverCatalog({ state, indexes, providers: ["lever"], exportPath: state.slice(0,-5) })).rejects.toThrow(".sqlite");
});

test("Common Crawl's normalized prefix in a no-captures reply does not stall pagination", async () => {
  const state = await statePath();
  const result = await discoverCatalog({ state, indexes: [indexes[0]!], providers: ["greenhouse"], execute: true }, {
    sleep: async () => {}, fetch: async input => {
      const u = new URL(input);
      if (u.searchParams.has("showNumPages")) return Response.json({ pages: 2, pageSize: 1 });
      if (u.searchParams.get("page") === "0") return Response.json({ message: `No Captures found for: ${u.searchParams.get("url")!.replace(/\*$/, "")}` }, { status: 404 });
      return new Response(JSON.stringify({ url: "https://job-boards.greenhouse.io/acme/jobs/1" }));
    },
  });
  expect(result.status).toBe("complete"); expect(result.boards).toBe(1);
  expect(result.queries.every(q=>q.next_page===2)).toBe(true);
});
