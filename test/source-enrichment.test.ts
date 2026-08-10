import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeEnrichmentLeads } from "../src/enrichment-registry.ts";
import { enrichSourcesFromCompanies } from "../src/source-enrichment.ts";

test("authoritative company joins promote Greenhouse but keep Ashby awaiting redirect evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-enrich-"));
  const registry = join(directory, "leads.json");
  const companies = join(directory, "companies.json");
  const candidates = join(directory, "candidates.json");
  await writeFile(companies, JSON.stringify([{ companyName: "Acme", companyDomain: "acme.test" }]));
  await mergeEnrichmentLeads(registry, ["greenhouse", "ashby"].map((ats) => ({ sourceKey: `${ats}:acme`, sourceUrl: ats === "greenhouse" ? "https://job-boards.greenhouse.io/acme" : "https://jobs.ashbyhq.com/acme", ats: ats as "greenhouse" | "ashby", token: "acme", discoveredFrom: [{ channel: "dataset", reference: "cc" }], companyMatches: [], identityEvidence: [], attempts: [] })));
  const report = await enrichSourcesFromCompanies(registry, companies, candidates, join(directory, "report.json"), { evidenceKind: "authoritative_dataset", now: new Date("2026-08-10T00:00:00.000Z") });
  expect(report).toEqual(expect.objectContaining({ matched: 1, evidenceReady: 1, promoted: 1 }));
  expect(JSON.parse(await readFile(candidates, "utf8"))).toEqual([expect.objectContaining({ companyName: "Acme", sourceUrl: "https://job-boards.greenhouse.io/acme" })]);
});
