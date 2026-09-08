import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitSites } from "../src/site-admission.ts";
import { fetchSourceJobs } from "../src/catalog.ts";

test("sites with JobPosting markup join the catalog as company_site sources, known employers are skipped, and the crawler reads them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-admit-sites-"));
  const reportPath = join(directory, "report.json");
  const catalogPath = join(directory, "companies.json");
  await writeFile(catalogPath, JSON.stringify({ acme: { name: "Acme", ats: "greenhouse", token: "acme", companyDomain: "acme.test", sourceUrl: "https://job-boards.greenhouse.io/acme", verification: { identityEvidence: "provider_company_name" } }, lepton: { name: "Other Lepton", ats: "lever", token: "lepton", companyDomain: "lepton.io", sourceUrl: "https://jobs.lever.co/lepton" } }));
  await writeFile(reportPath, JSON.stringify({ sites: [
    { companyName: "Lepton Software", companyDomain: "leptonsoftware.com", careerUrl: "https://leptonsoftware.com/careers/", postings: 18, indiaPostings: 18 },
    { companyName: "Lepton Again", companyDomain: "www.lepton.io", careerUrl: "https://lepton.io/careers", postings: 3, indiaPostings: 0 },
    { companyName: "Silent", companyDomain: "silent.test", careerUrl: "https://silent.test/careers", postings: 0, indiaPostings: 0 },
    { companyName: "No page", companyDomain: "nopage.test", postings: 2, indiaPostings: 2 },
  ] }));
  const result = await admitSites(reportPath, catalogPath, { now: new Date("2026-09-08T09:00:00.000Z") });
  expect(result).toEqual({ admitted: ["leptonsoftware"], skippedKnown: ["lepton.io"], catalogSize: 3 });
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  expect(catalog.leptonsoftware).toEqual(expect.objectContaining({ ats: "jobposting", token: "https://leptonsoftware.com/careers/", companyDomain: "leptonsoftware.com", cohorts: ["IN"], verification: expect.objectContaining({ identityEvidence: "company_site", jobCount: 18 }) }));
});

test("fetchSourceJobs refuses a company site source without a domain", async () => {
  await expect(fetchSourceJobs({ slug: "x", name: "X", ats: "jobposting", token: "https://x.test/careers" })).rejects.toThrow("no company domain");
});
