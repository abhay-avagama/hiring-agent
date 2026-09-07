import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { humanize, looksLikeTestBoard, verifyBoards } from "../src/board-verification.ts";

const lead = (ats: "greenhouse" | "lever" | "ashby" | "recruitee" | "workday", token: string, url: string, extra: Record<string, unknown> = {}) => ({
  sourceKey: `${ats}:${token.toLowerCase()}`, sourceUrl: url, ats, token, discoveredFrom: [{ channel: "dataset", reference: "common-crawl" }], companyMatches: [], identityEvidence: [], attempts: [], ...extra,
});

test("board-verified tier admits live boards on provider identity, skips known and failed ones, and records attempts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boards-"));
  const registry = join(dir, "leads.json"); const catalog = join(dir, "companies.json");
  await writeFile(registry, JSON.stringify({ version: 1, updatedAt: "2026-09-01T00:00:00.000Z", leads: [
    lead("greenhouse", "acme", "https://job-boards.greenhouse.io/acme"),
    lead("ashby", "beta-labs", "https://jobs.ashbyhq.com/beta-labs"),
    lead("lever", "empty", "https://jobs.lever.co/empty"),
    lead("recruitee", "gone", "https://gone.recruitee.com"),
    lead("greenhouse", "known", "https://job-boards.greenhouse.io/known"),
    lead("workday", "globex.wd1.myworkdayjobs.com/globex/External", "https://globex.wd1.myworkdayjobs.com/en-US/External"),
    lead("ashby", "cooling", "https://jobs.ashbyhq.com/cooling", { attempts: [{ attemptedAt: "2026-09-05T00:00:00.000Z", outcome: "permanent_failure", category: "empty_board" }] }),
  ] }));
  await writeFile(catalog, JSON.stringify({ known: { name: "Known", ats: "greenhouse", token: "known", companyDomain: "known.test", sourceUrl: "https://job-boards.greenhouse.io/known", discoveredFrom: { channel: "dataset", reference: "x" }, verification: { observedCompanyName: "Known", identityEvidence: "provider_company_name", contentType: "application/json", payloadVersion: "greenhouse-job-board:v1", jobCount: 1, checkedAt: "2026-09-01T00:00:00.000Z", canonicalSourceUrl: "https://job-boards.greenhouse.io/known" } } }));
  const calls: string[] = [];
  const report = await verifyBoards(registry, catalog, {
    now: () => new Date("2026-09-07T00:00:00.000Z"),
    fetch: async (input) => {
      const url = String(input); calls.push(url);
      if (url.includes("boards/acme")) return Response.json({ jobs: [{ id: 1, title: "Engineer", company_name: "Acme Inc" }, { id: 2, title: "Designer", company_name: "Acme Inc" }] });
      if (url.includes("beta-labs")) return Response.json({ apiVersion: "1", jobs: [{ id: "a", title: "Engineer" }] });
      if (url.includes("postings/empty")) return Response.json([]);
      if (url.includes("gone.recruitee")) return new Response("nope", { status: 404 });
      if (url.includes("myworkdayjobs")) return Response.json({ total: 250, jobPostings: [{ title: "Engineer", externalPath: "/job/x" }] });
      return new Response("unexpected", { status: 500 });
    },
  });
  expect(report.verified).toBe(3);
  expect(report.added).toEqual(["acme", "beta-labs", "globex"]);
  expect(report.skipped).toEqual({ inCatalog: 1, coolingDown: 1, unsupported: 0, deferred: 0 });
  expect(report.rejected.map((entry) => [entry.sourceKey, entry.reason])).toEqual([["lever:empty", "empty_board"], ["recruitee:gone", "invalid_payload"]]);
  expect(calls.some((url) => url.includes("known") || url.includes("cooling"))).toBe(false);

  const written = JSON.parse(await readFile(catalog, "utf8")) as Record<string, { name: string; companyDomain?: string; verification: { identityEvidence: string } }>;
  expect(Object.keys(written)).toEqual(["acme", "beta-labs", "globex", "known"]);
  expect(written.globex?.name).toBe("Globex");
  expect(written.globex?.verification.identityEvidence).toBe("provider_board");
  expect(written.acme?.name).toBe("Acme Inc");
  expect(written["beta-labs"]?.name).toBe("Beta Labs");
  expect(written.acme?.companyDomain).toBeUndefined();
  expect(written.acme?.verification.identityEvidence).toBe("provider_board");
  expect(written.known?.companyDomain).toBe("known.test");

  const leads = (JSON.parse(await readFile(registry, "utf8")) as { leads: Array<{ sourceKey: string; promotedAt?: string; attempts: Array<{ outcome: string }> }> }).leads;
  expect(leads.find((entry) => entry.sourceKey === "greenhouse:acme")?.promotedAt).toBe("2026-09-07T00:00:00.000Z");
  expect(leads.find((entry) => entry.sourceKey === "lever:empty")?.attempts.map((attempt) => attempt.outcome)).toEqual(["permanent_failure"]);

  const again = await verifyBoards(registry, catalog, { now: () => new Date("2026-09-07T01:00:00.000Z"), fetch: async () => new Response(null, { status: 500 }) });
  expect(again.selected).toBe(0);
  expect(again.skipped.inCatalog).toBe(4);
  expect(again.skipped.coolingDown).toBe(3);
});

test("humanize turns a board token into a display name", () => {
  expect(humanize("beta-labs")).toBe("Beta Labs");
  expect(humanize("acme")).toBe("Acme");
});

test("random-looking board tokens are treated as test boards, short brand tokens are not", () => {
  for (const token of ["12jlkfsk", "1456754456yhgbhfg", "5364856uhdfnvbkldfnbhrpkdfgbdvtyhro"]) expect(looksLikeTestBoard(token)).toBe(true);
  for (const token of ["2k", "8vc", "bvnk", "540", "103644278", "beta-labs", "1password", "84-51"]) expect(looksLikeTestBoard(token)).toBe(false);
});
