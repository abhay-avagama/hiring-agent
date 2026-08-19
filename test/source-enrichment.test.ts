import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeEnrichmentLeads, readEnrichmentRegistry } from "../src/enrichment-registry.ts";
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

test("enrichment combines seed arrays with verified catalog objects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-enrich-inputs-"));
  const registry = join(directory, "leads.json");
  const seeds = join(directory, "seeds.json");
  const catalog = join(directory, "catalog.json");
  const candidates = join(directory, "candidates.json");
  await writeFile(seeds, JSON.stringify([{ companyName: "Acme", companyDomain: "acme.test" }]));
  const verification = { checkedAt: "2026-08-01T00:00:00.000Z", observedCompanyName: "Company", identityEvidence: "provider_company_name", contentType: "application/json", payloadVersion: "test:v1", jobCount: 1 };
  await writeFile(catalog, JSON.stringify({
    acme: { name: "Acme Inc", companyDomain: "acme.test", ats: "greenhouse", token: "acme", sourceUrl: "https://job-boards.greenhouse.io/acme", verification: { ...verification, canonicalSourceUrl: "https://job-boards.greenhouse.io/acme" } },
    beta: { name: "Beta Systems", companyDomain: "beta.test", ats: "workday", token: "beta.wd1.myworkdayjobs.com/beta/Careers", sourceUrl: "https://beta.wd1.myworkdayjobs.com/en-US/Careers", verification: { ...verification, identityEvidence: "provider_tenant", canonicalSourceUrl: "https://beta.wd1.myworkdayjobs.com/en-US/Careers" } },
  }));
  await mergeEnrichmentLeads(registry, [
    { sourceKey: "greenhouse:acme", sourceUrl: "https://job-boards.greenhouse.io/acme", ats: "greenhouse", token: "acme", discoveredFrom: [{ channel: "dataset", reference: "cc" }], companyMatches: [], identityEvidence: [], attempts: [] },
    { sourceKey: "workday:beta.wd1.myworkdayjobs.com/beta/careers", sourceUrl: "https://beta.wd1.myworkdayjobs.com/en-US/Careers", ats: "workday", token: "beta.wd1.myworkdayjobs.com/beta/Careers", discoveredFrom: [{ channel: "dataset", reference: "cc" }], companyMatches: [], identityEvidence: [], attempts: [] },
  ]);

  const report = await enrichSourcesFromCompanies(registry, [seeds, catalog], candidates, join(directory, "report.json"), { evidenceKind: "company_registry" });

  expect(report).toEqual(expect.objectContaining({ companiesChecked: 3, evidenceReady: 2, promoted: 2, companyInputs: [seeds, catalog] }));
  expect(JSON.parse(await readFile(candidates, "utf8")).map((candidate: { companyName: string }) => candidate.companyName)).toEqual(["Acme Inc", "Beta Systems"]);
  expect((await readEnrichmentRegistry(registry)).leads.find((lead) => lead.token === "acme")?.identityEvidence).toHaveLength(2);
});

test("object enrichment inputs must contain independently verified catalog records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-enrich-invalid-catalog-"));
  const registry = join(directory, "leads.json");
  const catalog = join(directory, "catalog.json");
  await writeFile(catalog, JSON.stringify({ acme: { name: "Acme", companyDomain: "acme.test", ats: "greenhouse", token: "acme", sourceUrl: "garbage", verification: {} } }));

  await expect(enrichSourcesFromCompanies(registry, catalog, join(directory, "candidates.json"), join(directory, "report.json"), { evidenceKind: "company_registry" }))
    .rejects.toThrow("does not contain verified catalog records");
});

test("legacy malformed Workday leads remain readable but cannot become candidates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-enrichment-legacy-"));
  const registry = join(directory, "registry.json");
  const candidates = join(directory, "candidates.json");
  await writeFile(registry, JSON.stringify({ version: 1, updatedAt: "2026-08-19T00:00:00.000Z", leads: [{
    sourceKey: "workday:acme.wd1.myworkdayjobs.com/acme/robots.txt", sourceUrl: "https://acme.wd1.myworkdayjobs.com/en-US/robots.txt",
    ats: "workday", token: "acme.wd1.myworkdayjobs.com/acme/robots.txt", discoveredFrom: [{ channel: "dataset", reference: "legacy" }],
    companyMatches: [], identityEvidence: [], attempts: [],
  }] }));
  const companies = join(directory, "companies.json");
  await writeFile(companies, JSON.stringify([{ companyName: "Acme", companyDomain: "acme.test" }]));
  const report = await enrichSourcesFromCompanies(registry, companies, candidates, join(directory, "report.json"), { evidenceKind: "authoritative_dataset" });
  expect(report.evidenceReady).toBe(0);
  expect(report.promoted).toBe(0);
  expect(JSON.parse(await readFile(candidates, "utf8"))).toEqual([]);
});
