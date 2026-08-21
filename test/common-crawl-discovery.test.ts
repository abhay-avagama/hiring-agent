import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCommonCrawlSources } from "../src/common-crawl-discovery.ts";

test("Common Crawl URL discovery canonicalizes ATS leads without promoting unknown identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-common-crawl-"));
  const candidatesPath = join(directory, "candidates.json");
  const reportPath = join(directory, "report.json");
  const registryPath = join(directory, "enrichment-leads.json");
  await writeFile(candidatesPath, JSON.stringify([
    { companyName: "Known", companyDomain: "known.test", sourceUrl: "https://jobs.lever.co/known", discoveredFrom: { channel: "legacy", reference: "seed" } },
  ]));

  const report = await discoverCommonCrawlSources(candidatesPath, reportPath, {
    country: "IN", registryPath,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("collinfo.json")) return Response.json([{ id: "CC-MAIN-TEST", "cdx-api": "https://index.test/CC-MAIN-TEST-index" }]);
      if (url.includes("jobs.lever.co")) return new Response([
        JSON.stringify({ url: "https://jobs.lever.co/known/123" }),
        JSON.stringify({ url: "https://jobs.lever.co/newco/456" }),
      ].join("\n"));
      if (url.includes("greenhouse")) return new Response(`${JSON.stringify({ url: "https://boards.greenhouse.io/acme/jobs/1" })}\n${JSON.stringify({ url: "https://job-boards.greenhouse.io/acme" })}`);
      if (url.includes("myworkdayjobs")) return new Response(JSON.stringify({ url: "https://mastercard.wd1.myworkdayjobs.com/en-US/CorporateCareers/job/Pune-India/Engineer_R-1" }));
      if (url.includes("recruitee.com")) return new Response(JSON.stringify({ url: "https://transperfect.recruitee.com/o/software-engineer" }));
      return new Response("");
    },
  });

  expect(report).toEqual(expect.objectContaining({ country: "IN", urlsSeen: 6, sourcesFound: 5, alreadyKnown: 1, unresolved: 4, rejected: 0, truncated: false, registryAdded: 4 }));
  expect(report.leads.map((lead) => lead.sourceUrl).sort()).toEqual([
    "https://job-boards.greenhouse.io/acme",
    "https://jobs.lever.co/newco",
    "https://mastercard.wd1.myworkdayjobs.com/en-US/CorporateCareers",
    "https://transperfect.recruitee.com",
  ]);
  expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);
  expect(JSON.parse(await readFile(registryPath, "utf8")).leads).toHaveLength(4);
});

test("Recruitee discovery is one bounded report-only fetch with deterministic token sampling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-common-crawl-"));
  const candidatesPath = join(directory, "candidates.json");
  const artifactRoot = join(directory, ".openings");
  const reportPath = join(artifactRoot, "round5.json");
  await writeFile(candidatesPath, "[]\n");
  const requests: string[] = [];
  const records = ["zeta", "known", "alpha", "alpha", "beta"].map((token, index) => JSON.stringify({ url: `https://${token}.recruitee.com/o/job-${index}` })).join("\n");

  const report = await discoverCommonCrawlSources(candidatesPath, reportPath, {
    indexUrl: "https://index.test/CC-MAIN-PINNED-index",
    provider: "recruitee",
    indexRecordLimit: 5,
    sampleTokenLimit: 2,
    excludeTokens: ["known"],
    fetch: async (input) => { requests.push(String(input)); return new Response(records); },
  });

  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]!).searchParams.get("url")).toBe("*.recruitee.com/*");
  expect(new URL(requests[0]!).searchParams.get("limit")).toBe("5");
  expect(report.indexRecordsExamined).toBe(5);
  expect(report.availableLeads.map((lead) => lead.token)).toEqual(["alpha", "beta", "zeta"]);
  expect(report.leads.map((lead) => lead.token)).toEqual(["alpha", "beta"]);
  expect(report.sampleShortfall).toBe(0);
  expect(report.registryPath).toBeUndefined();
});
