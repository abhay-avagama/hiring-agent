import { expect, test } from "bun:test";
import { createCatalog, fetchSourceJobs } from "../src/catalog.ts";
import { plainText, resolveProviderSource } from "../src/providers.ts";
import { resolveSource } from "../src/source-verification.ts";
import { verifyBoards } from "../src/board-verification.ts";
import type { Company } from "../src/types.ts";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("table-driven providers resolve board and API URLs to canonical sources", () => {
  expect(resolveSource("https://jobs.smartrecruiters.com/Acme/123-engineer")).toMatchObject({ ats: "smartrecruiters", token: "Acme", canonicalSourceUrl: "https://jobs.smartrecruiters.com/Acme" });
  expect(resolveSource("https://api.smartrecruiters.com/v1/companies/Acme/postings")?.token).toBe("Acme");
  expect(resolveSource("https://apply.workable.com/acme-inc/j/ABC123/")).toMatchObject({ ats: "workable", token: "acme-inc", structuredEndpoint: "https://apply.workable.com/api/v1/widget/accounts/acme-inc" });
  expect(resolveSource("https://acme.workable.com/")?.token).toBe("acme");
  expect(resolveSource("https://apply.workable.com/j/ABC123")).toBeNull();
  expect(resolveSource("https://acme.breezy.hr/p/abc-engineer")).toMatchObject({ ats: "breezy", token: "acme", structuredEndpoint: "https://acme.breezy.hr/json?verbose=true" });
  expect(resolveProviderSource("https://job-boards.greenhouse.io/acme")).toBeNull();
  expect(resolveSource("https://job-boards.greenhouse.io/acme")?.ats).toBe("greenhouse");
});

const company = (ats: Company["ats"], token: string): Company => ({ slug: "acme", name: "Acme", ats, token });

test("SmartRecruiters pages through postings and fetches descriptions on demand", async () => {
  const posting = (id: number) => ({ id: String(id), name: `Engineer ${id}`, company: { identifier: "acme", name: "Acme Inc" }, releasedDate: "2026-09-01T00:00:00.000Z", location: { city: "Bengaluru", region: "Karnataka", country: "in", remote: false, hybrid: true, fullLocation: "Bengaluru, Karnataka, India" } });
  const calls: string[] = [];
  const fetcher = (async (input: string | URL) => {
    const url = String(input); calls.push(url);
    if (url.includes("/postings/101")) return Response.json({ id: "101", jobAd: { sections: { jobDescription: { text: "<p>Build <b>things</b>.</p>" }, qualifications: { text: "<ul><li>5 years</li></ul>" } } } });
    const offset = Number(new URL(url).searchParams.get("offset"));
    return Response.json({ totalFound: 150, offset, limit: 100, content: Array.from({ length: offset === 0 ? 100 : 50 }, (_, i) => posting(offset + i + 1)) });
  }) as typeof fetch;
  const jobs = await fetchSourceJobs(company("smartrecruiters", "acme"), fetcher);
  expect(jobs).toHaveLength(150);
  expect(jobs[0]).toMatchObject({ id: "smartrecruiters:acme:1", title: "Engineer 1", location: "Bengaluru, Karnataka, India", workMode: "hybrid", url: "https://jobs.smartrecruiters.com/acme/1", eligibleCountries: ["IN"] });
  expect(calls.filter((url) => url.includes("offset="))).toHaveLength(2);
  const catalog = createCatalog({ companies: [company("smartrecruiters", "acme")], fetch: fetcher });
  const detailed = await catalog.get("smartrecruiters:acme:101");
  expect(detailed?.description).toBe("Build things.\n\n5 years");
});

test("Workable widget jobs normalise with remote flags and load descriptions from the v2 job endpoint", async () => {
  const fetcher = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/api/v2/")) return Response.json({ description: "<p>Do the work</p>", requirements: "<p>Know things</p>", benefits: "" });
    return Response.json({ name: "Acme", description: null, jobs: [{ title: "Engineer", shortcode: "AB12", url: "https://apply.workable.com/j/AB12", telecommuting: true, city: "Luanda", state: "Luanda Province", country: "Angola", published_on: "2026-09-01", locations: [{ country: "Angola", countryCode: "AO" }] }] });
  }) as typeof fetch;
  const jobs = await fetchSourceJobs(company("workable", "acme"), fetcher);
  expect(jobs[0]).toMatchObject({ id: "workable:acme:AB12", remote: true, workMode: "remote", location: "Luanda, Luanda Province, Angola", eligibleCountries: ["AO"] });
  const catalog = createCatalog({ companies: [company("workable", "acme")], fetch: fetcher });
  expect((await catalog.get("workable:acme:AB12"))?.description).toBe("Do the work\n\nKnow things");
});

test("Breezy verbose listing carries descriptions and the company name", async () => {
  const fetcher = (async () => Response.json([{ id: "p1", friendly_id: "p1-engineer", name: "Engineer", url: "https://acme.breezy.hr/p/p1-engineer", published_date: "2026-09-01T00:00:00Z", description: "<p>Ship &amp; learn</p>", company: { name: "Acme Ltd" }, location: { name: "Pune, India", city: "Pune", country: { name: "India", id: "IN" }, is_remote: false } }])) as unknown as typeof fetch;
  const jobs = await fetchSourceJobs(company("breezy", "acme"), fetcher);
  expect(jobs[0]).toMatchObject({ id: "breezy:acme:p1", title: "Engineer", location: "Pune, India", description: "Ship & learn", eligibleCountries: ["IN"] });
});

test("board-verified tier admits the new providers and takes the name from the provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boards-"));
  const registry = join(dir, "leads.json"); const catalog = join(dir, "companies.json");
  const lead = (ats: string, token: string, url: string) => ({ sourceKey: `${ats}:${token.toLowerCase()}`, sourceUrl: url, ats, token, discoveredFrom: [{ channel: "dataset", reference: "x" }], companyMatches: [], identityEvidence: [], attempts: [] });
  await writeFile(registry, JSON.stringify({ version: 1, updatedAt: "2026-09-01T00:00:00.000Z", leads: [lead("workable", "acme", "https://apply.workable.com/acme/"), lead("breezy", "beta", "https://beta.breezy.hr/"), lead("smartrecruiters", "Gamma", "https://jobs.smartrecruiters.com/Gamma")] }));
  await writeFile(catalog, "{}");
  const report = await verifyBoards(registry, catalog, { now: () => new Date("2026-09-07T00:00:00.000Z"), fetch: (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("workable")) return Response.json({ name: "Acme Widgets", jobs: [{ title: "x", shortcode: "1" }] });
    if (url.includes("breezy")) return Response.json([{ id: "1", name: "x", company: { name: "Beta Co" } }]);
    return Response.json({ totalFound: 1, content: [{ id: "1", name: "x", company: { name: "Gamma GmbH" } }] });
  }) as typeof fetch });
  expect(report.verified).toBe(3);
  const written = JSON.parse(await readFile(catalog, "utf8")) as Record<string, { name: string; ats: string }>;
  expect(Object.values(written).map((entry) => [entry.ats, entry.name])).toEqual([["workable", "Acme Widgets"], ["breezy", "Beta Co"], ["smartrecruiters", "Gamma GmbH"]]);
});

test("plainText strips markup and entities", () => {
  expect(plainText("<p>Hi&nbsp;there</p><ul><li>one</li><li>two</li></ul>")).toBe("Hi there\none\ntwo");
});

test("Freshteam widget jobs carry branch locations, descriptions, and provider-hosted urls", async () => {
  const fetcher = (async () => Response.json({ jobs: [{ id: 1, unique_id: "hSxg4m", title: "Sales Specialist", description: "<p>Sell &amp; grow</p>", remote: false, branch_id: 9, deleted: false, created_at: "2026-09-01T00:00:00.000Z" }, { id: 2, unique_id: "gone", title: "Old", description: "", deleted: true, branch_id: 9 }], branches: [{ id: 9, city: "Delhi", state: "Delhi", country_code: "in" }], job_roles: [] })) as unknown as typeof fetch;
  const jobs = await fetchSourceJobs(company("freshteam", "tentimes"), fetcher);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ id: "freshteam:acme:hSxg4m", title: "Sales Specialist", location: "Delhi, Delhi, IN", description: "Sell & grow", url: "https://tentimes.freshteam.com/jobs/hSxg4m", eligibleCountries: ["IN"] });
  expect(resolveSource("https://tentimes.freshteam.com/jobs/hSxg4m")).toMatchObject({ ats: "freshteam", token: "tentimes", structuredEndpoint: "https://tentimes.freshteam.com/hire/widgets/jobs.json" });
});
