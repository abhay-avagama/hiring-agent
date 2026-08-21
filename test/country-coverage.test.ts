import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCountryCoverageReport } from "../src/country-coverage.ts";
import type { Job, JobSnapshot } from "../src/types.ts";

const job = (id: string, company: string, confidence: Job["eligibilityConfidence"], eligibleCountries: string[] = ["IN"], eligibleRegions: string[] = []): Job => ({
  id, company, title: "Engineer", location: "Remote", remote: true, workMode: "remote",
  eligibleCountries, excludedCountries: [], eligibleRegions, eligibilityConfidence: confidence,
  url: `https://example.test/${id}`, description: "Build systems",
});

test("reports deterministic country coverage across catalog, snapshot, discovery, health, and freshness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-coverage-"));
  const paths = {
    catalog: join(directory, "companies.json"), candidates: join(directory, "candidates.json"),
    registry: join(directory, "registry.json"), snapshot: join(directory, "snapshot.json"), output: join(directory, "coverage.json"),
  };
  await writeFile(paths.catalog, JSON.stringify({
    acme: company("Acme", "greenhouse", "acme", "acme.test", "https://job-boards.greenhouse.io/acme", ["IN"]),
    beta: company("Beta", "workday", "beta.wd1.myworkdayjobs.com/beta/Careers", "beta.test", "https://beta.wd1.myworkdayjobs.com/en-US/Careers", ["IN"]),
    gamma: company("Gamma", "lever", "gamma", "gamma.test", "https://jobs.lever.co/gamma", ["DE"]),
  }));
  await writeFile(paths.candidates, JSON.stringify([
    candidate("Acme", "acme.test", "https://job-boards.greenhouse.io/acme", ["IN"]),
    candidate("Beta", "beta.test", "https://beta.wd1.myworkdayjobs.com/en-US/Careers", ["IN"]),
    candidate("Delta", "delta.test", "https://jobs.lever.co/delta", ["IN"]),
    candidate("Gamma", "gamma.test", "https://jobs.lever.co/gamma", ["DE"]),
  ]));
  await writeFile(paths.registry, JSON.stringify({ version: 1, updatedAt: "2026-08-19T00:00:00.000Z", leads: [
    lead("greenhouse", "acme", "https://job-boards.greenhouse.io/acme", "success", true),
    lead("lever", "delta", "https://jobs.lever.co/delta", undefined, true),
    lead("ashby", "epsilon", "https://jobs.ashbyhq.com/epsilon", "permanent_failure", true),
  ] }));
  const snapshot: JobSnapshot = {
    version: 1, updatedAt: "2026-08-19T00:00:00.000Z",
    partitions: {
      acme: { fetchedAt: "2026-08-18T18:00:00.000Z", jobs: [job("greenhouse:acme:1", "Acme", "explicit")] },
      beta: { fetchedAt: "2026-08-10T00:00:00.000Z", jobs: [job("workday:beta:1", "Beta", "inferred", [], ["APAC"])] },
      retired: { fetchedAt: "2026-08-19T00:00:00.000Z", jobs: [job("lever:retired:1", "Retired", "explicit")] },
    },
    lastCrawl: { startedAt: "2026-08-19T00:00:00.000Z", finishedAt: "2026-08-19T00:01:00.000Z", selected: 2, succeeded: 1, failed: [{ source: "beta", error: "HTTP 429" }] },
  };
  await writeFile(paths.snapshot, JSON.stringify(snapshot));

  const report = await generateCountryCoverageReport(paths, { country: "IN", asOf: new Date("2026-08-19T00:00:00.000Z") });

  expect(report).toEqual(expect.objectContaining({
    pipelineVersion: "country-coverage:1", schemaVersion: 1, generatedAt: "2026-08-19T00:00:00.000Z", country: "IN",
    catalog: {
      verifiedSources: 3, countryCohortSources: 2,
      providers: { greenhouse: 1, lever: 1, workday: 1 }, countryCohortProviders: { greenhouse: 1, workday: 1 },
    },
    snapshot: {
      updatedAt: "2026-08-19T00:00:00.000Z", indexedSources: 2, countryCohortIndexedSources: 2, catalogCoveragePercent: 66.67,
      orphanedSources: ["retired"], snapshotJobs: 3, indexedJobs: 2, indexedSourcesWithEligibleJobs: 2, eligibleJobs: 2,
      distinctEligibleEmployers: 2, indexedProviders: { greenhouse: 1, workday: 1 },
      countryCohortIndexedProviders: { greenhouse: 1, workday: 1 },
      allIndexedJobsByConfidence: { explicit: 1, inferred: 1, unknown: 0 },
      eligibleJobsByConfidence: { explicit: 1, inferred: 1, unknown: 0 },
    },
    sourceHealth: { latestBatch: { selected: 2, succeeded: 1, failed: 1, successPercent: 50 } },
    freshness: {
      referenceAt: "2026-08-19T00:00:00.000Z", fresh24Hours: 1, age1To7Days: 0, age8To14Days: 1,
      olderThan14Days: 0, futureTimestamp: 0, neverIndexedSources: ["gamma"],
      oldestFetchedAt: "2026-08-10T00:00:00.000Z", newestFetchedAt: "2026-08-18T18:00:00.000Z",
      sources: { fresh24Hours: ["acme"], age1To7Days: [], age8To14Days: ["beta"], olderThan14Days: [], futureTimestamp: [] },
    },
    discovery: {
      registryLeadsGlobal: 3, registryStatesGlobal: { unresolved: 0, matched: 1, evidence_ready: 0, verified: 1, rejected: 1 },
      verifiedRegistryLeadsGlobal: 1, registryVerificationYieldPercentGlobal: 33.33,
      candidatesGlobal: 4, promotedCandidatesGlobal: 3, candidatePromotionPercentGlobal: 75,
      countryCohortCandidates: 3, promotedCountryCohortCandidates: 2, countryCohortCandidatePromotionPercent: 66.67,
    },
  }));
  expect(JSON.parse(await readFile(paths.output, "utf8"))).toEqual(report);
});

test("rejects malformed partition jobs instead of producing partial metrics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-coverage-invalid-"));
  const paths = {
    catalog: join(directory, "companies.json"), candidates: join(directory, "candidates.json"),
    registry: join(directory, "registry.json"), snapshot: join(directory, "snapshot.json"),
  };
  await writeFile(paths.catalog, "{}");
  await writeFile(paths.candidates, "[]");
  await writeFile(paths.registry, JSON.stringify({ version: 1, updatedAt: "2026-08-19T00:00:00.000Z", leads: [] }));
  await writeFile(paths.snapshot, JSON.stringify({
    version: 1, updatedAt: "2026-08-19T00:00:00.000Z",
    partitions: { broken: { fetchedAt: "2026-08-19T00:00:00.000Z", jobs: [{ id: "incomplete" }] } },
    lastCrawl: { startedAt: "2026-08-19T00:00:00.000Z", finishedAt: "2026-08-19T00:00:00.000Z", selected: 0, succeeded: 0, failed: [] },
  }));
  await expect(generateCountryCoverageReport(paths, { country: "IN" })).rejects.toThrow("Invalid job snapshot");
});

test("isolates future partitions and rejects impossible crawl health", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-coverage-future-"));
  const paths = {
    catalog: join(directory, "companies.json"), candidates: join(directory, "candidates.json"),
    registry: join(directory, "registry.json"), snapshot: join(directory, "snapshot.json"),
  };
  await writeFile(paths.catalog, JSON.stringify({
    acme: company("Acme", "greenhouse", "acme", "acme.test", "https://job-boards.greenhouse.io/acme", ["IN"]),
  }));
  await writeFile(paths.candidates, "[]");
  await writeFile(paths.registry, JSON.stringify({ version: 1, updatedAt: "2026-08-19T00:00:00.000Z", leads: [] }));
  const snapshot = {
    version: 1, updatedAt: "2026-08-19T00:00:00.000Z",
    partitions: { acme: { fetchedAt: "2026-08-20T00:00:00.000Z", jobs: [job("greenhouse:acme:1", "Acme", "explicit")] } },
    lastCrawl: { startedAt: "2026-08-19T00:00:00.000Z", finishedAt: "2026-08-19T00:00:00.000Z", selected: 1, succeeded: 1, failed: [] },
  };
  await writeFile(paths.snapshot, JSON.stringify(snapshot));
  const report = await generateCountryCoverageReport(paths, { country: "IN", asOf: new Date("2026-08-19T00:00:00.000Z") });
  expect(report.freshness).toEqual(expect.objectContaining({
    fresh24Hours: 0, age1To7Days: 0, age8To14Days: 0, olderThan14Days: 0, futureTimestamp: 1,
    oldestFetchedAt: "2026-08-20T00:00:00.000Z", newestFetchedAt: "2026-08-20T00:00:00.000Z",
  }));
  expect(report.freshness.sources.futureTimestamp).toEqual(["acme"]);

  snapshot.lastCrawl = { ...snapshot.lastCrawl, selected: 1, succeeded: 2 };
  await writeFile(paths.snapshot, JSON.stringify(snapshot));
  await expect(generateCountryCoverageReport(paths, { country: "IN" })).rejects.toThrow("Invalid job snapshot");
});

test("rejects malformed catalog cohorts and partition timestamps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-coverage-schema-"));
  const paths = {
    catalog: join(directory, "companies.json"), candidates: join(directory, "candidates.json"),
    registry: join(directory, "registry.json"), snapshot: join(directory, "snapshot.json"),
  };
  const acme = company("Acme", "greenhouse", "acme", "acme.test", "https://job-boards.greenhouse.io/acme", ["IN"]);
  await writeFile(paths.catalog, JSON.stringify({ acme: { ...acme, cohorts: "IN" } }));
  await writeFile(paths.candidates, "[]");
  await writeFile(paths.registry, JSON.stringify({ version: 1, updatedAt: "2026-08-19T00:00:00.000Z", leads: [] }));
  await writeFile(paths.snapshot, JSON.stringify({
    version: 1, updatedAt: "2026-08-19T00:00:00.000Z", partitions: {},
    lastCrawl: { startedAt: "2026-08-19T00:00:00.000Z", finishedAt: "2026-08-19T00:00:00.000Z", selected: 0, succeeded: 0, failed: [] },
  }));
  await expect(generateCountryCoverageReport(paths, { country: "IN" })).rejects.toThrow("Invalid verified catalog source");

  await writeFile(paths.catalog, JSON.stringify({ acme }));
  const invalidSnapshot = {
    version: 1, updatedAt: "2026-08-19T00:00:00.000Z", partitions: { acme: { fetchedAt: "not-a-date", jobs: [] } },
    lastCrawl: { startedAt: "2026-08-19T00:00:00.000Z", finishedAt: "2026-08-19T00:00:00.000Z", selected: 0, succeeded: 0, failed: [] },
  };
  await writeFile(paths.snapshot, JSON.stringify(invalidSnapshot));
  await expect(generateCountryCoverageReport(paths, { country: "IN" })).rejects.toThrow("Invalid job snapshot");
});

function company(name: string, ats: string, token: string, companyDomain: string, sourceUrl: string, cohorts: string[]) {
  return { name, ats, token, companyDomain, sourceUrl, cohorts, discoveredFrom: { channel: "search", reference: "fixture" }, verification: {
    checkedAt: "2026-08-19T00:00:00.000Z", canonicalSourceUrl: sourceUrl, observedCompanyName: name,
    identityEvidence: ats === "workday" ? "provider_tenant" : "provider_company_name", contentType: "application/json", payloadVersion: "fixture:1", jobCount: 1,
  } };
}
function candidate(companyName: string, companyDomain: string, sourceUrl: string, cohorts: string[]) {
  return { companyName, companyDomain, sourceUrl, cohorts, discoveredFrom: { channel: "search", reference: "fixture" } };
}
function lead(ats: string, token: string, sourceUrl: string, outcome: "success" | "permanent_failure" | undefined, matched: boolean) {
  return {
    sourceKey: `${ats}:${token}`, sourceUrl, ats, token, discoveredFrom: [{ channel: "search", reference: "fixture" }],
    companyMatches: matched ? [{ companyName: token, companyDomain: `${token}.test`, method: "search_result", reference: "fixture" }] : [],
    identityEvidence: matched && outcome !== undefined ? [{ companyName: token, companyDomain: `${token}.test`, kind: "company_redirect", reference: `https://${token}.test/careers`, observedAt: "2026-08-18T00:00:00.000Z" }] : [],
    attempts: outcome ? [{ attemptedAt: "2026-08-19T00:00:00.000Z", outcome }] : [],
    ...(outcome === "success" ? { promotedAt: "2026-08-19T00:00:00.000Z" } : {}),
  };
}
