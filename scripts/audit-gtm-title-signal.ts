import { readFile } from "node:fs/promises";
import type { Company, JobSnapshot } from "../src/types.ts";
import { isExactEngineerTitle, normalizeTitle, titlePattern } from "./gtm-title-signal.ts";

const snapshotPath = process.argv[2] ?? ".openings/snapshot.json";
const catalogPath = process.argv[3] ?? "data/companies.json";

const [snapshot, catalog] = await Promise.all([
  readFile(snapshotPath, "utf8").then((text) => JSON.parse(text) as JobSnapshot),
  readFile(catalogPath, "utf8").then((text) => JSON.parse(text) as Record<string, Company>),
]);

const jobs = Object.values(snapshot.partitions).flatMap((partition) => partition.jobs).sort((a, b) => a.id.localeCompare(b.id));
const matches = jobs.filter((job) => titlePattern.test(normalizeTitle(job.title)));
const exactEngineerMatches = jobs.filter((job) => isExactEngineerTitle(job.title));

const eligibleCountryCounts: Record<string, number> = {};
for (const job of matches) {
  const countries = job.eligibleCountries.length ? job.eligibleCountries : ["(unclassified)"];
  for (const country of countries) eligibleCountryCounts[country] = (eligibleCountryCounts[country] ?? 0) + 1;
}
const sortedCountryCounts = Object.fromEntries(Object.entries(eligibleCountryCounts).sort(([a], [b]) => a.localeCompare(b)));

const catalogCompanies = Object.values(catalog);
const workdayCount = catalogCompanies.filter((company) => company.ats === "workday").length;

console.log(JSON.stringify({
  snapshotPath,
  snapshotUpdatedAt: snapshot.updatedAt,
  catalogPath,
  totalJobs: jobs.length,
  titlePattern: titlePattern.source,
  broadMatchCount: matches.length,
  exactGtmOrRevopsEngineerTitleCount: exactEngineerMatches.length,
  distinctCompanyLabelsWithBroadMatch: [...new Set(matches.map((job) => job.company))].sort(),
  eligibleCountryCounts: sortedCountryCounts,
  catalogWorkdaySources: workdayCount,
  catalogTotalSources: catalogCompanies.length,
  caveat: `Current catalog and snapshot inputs are India-campaigned and Workday/large-enterprise skewed (${workdayCount} of ${catalogCompanies.length} verified catalog sources are Workday; the catalog and snapshot are read as two separate inputs with no cross-check that they describe the same generation). A near-zero count here does not measure absence of GTM Engineer demand in unindexed B2B SaaS startups — it measures only what a differently-biased corpus happens to contain.`,
}, null, 2));
