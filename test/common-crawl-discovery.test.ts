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

test("a region with no captures is an empty pattern, not a failed run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-cc-404-"));
  const candidatesPath = join(directory, "candidates.json");
  const reportPath = join(directory, "report.json");
  await writeFile(candidatesPath, JSON.stringify([]));

  // Oracle spreads tenants over Fusion regions and several hold nothing. Aborting on the first empty one threw
  // away every region that had already answered, which is how Oracle ended up with no discovered tenants at all.
  const report = await discoverCommonCrawlSources(candidatesPath, reportPath, {
    provider: "oraclecloud", registryPath: join(directory, "leads.json"), retryDelayMs: 0,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("collinfo.json")) return Response.json([{ id: "CC-MAIN-TEST", "cdx-api": "https://index.test/CC-MAIN-TEST-index" }]);
      if (url.includes("us2.oraclecloud.com")) {
        return new Response(JSON.stringify({ url: "https://ebuu.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/1" }) + "\n");
      }
      return new Response("not found", { status: 404 });   // every other region is empty
    },
  });

  expect(report.emptyPatterns.length).toBeGreaterThan(0);
  expect(report.leads.map((lead) => lead.token)).toContain("ebuu.fa.us2.oraclecloud.com/CX");
});

test("Oracle discovery asks the index one region at a time", async () => {
  const { commonCrawlPatterns } = await import("../src/common-crawl-discovery.ts");
  const patterns = commonCrawlPatterns("oraclecloud");
  expect(patterns.length).toBeGreaterThan(1);
  // The single host-wide pattern with a deep path suffix answered 504 every time it was tried.
  expect(patterns).not.toContain("*.fa.oraclecloud.com/hcmUI/CandidateExperience*");
  for (const pattern of patterns) expect(pattern).toMatch(/^\*\.fa\.[a-z0-9]+\.oraclecloud\.com\/\*$/);
});

test("one refused pattern does not discard the patterns that answered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-cc-partial-"));
  const candidatesPath = join(directory, "candidates.json");
  await writeFile(candidatesPath, JSON.stringify([]));
  // A sparse pattern asked for too many records times out. Throwing there lost every region already swept.
  const report = await discoverCommonCrawlSources(candidatesPath, join(directory, "report.json"), {
    provider: "oraclecloud", registryPath: join(directory, "leads.json"), retryDelayMs: 0,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("collinfo.json")) return Response.json([{ id: "T", "cdx-api": "https://index.test/T-index" }]);
      if (url.includes("us2.oraclecloud.com")) return new Response(JSON.stringify({ url: "https://ebuu.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/1" }) + "\n");
      return new Response("gateway timeout", { status: 504 });
    },
  });
  expect(report.failedPatterns.length).toBeGreaterThan(0);
  expect(report.leads.map((lead) => lead.token)).toContain("ebuu.fa.us2.oraclecloud.com/CX");
});

test("a sweep where every pattern is refused is an error, not a quiet zero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-cc-allfail-"));
  const candidatesPath = join(directory, "candidates.json");
  await writeFile(candidatesPath, JSON.stringify([]));
  await expect(discoverCommonCrawlSources(candidatesPath, join(directory, "report.json"), {
    provider: "oraclecloud", registryPath: join(directory, "leads.json"), retryDelayMs: 0,
    fetch: async (input) => String(input).endsWith("collinfo.json")
      ? Response.json([{ id: "T", "cdx-api": "https://index.test/T-index" }])
      : new Response("gateway timeout", { status: 504 }),
  })).rejects.toThrow(/refused every pattern/);
});
