import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCommonCrawlSources } from "../src/common-crawl-discovery.ts";

test("Common Crawl URL discovery canonicalizes ATS leads without promoting unknown identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-common-crawl-"));
  const candidatesPath = join(directory, "candidates.json");
  const reportPath = join(directory, "report.json");
  await writeFile(candidatesPath, JSON.stringify([
    { companyName: "Known", companyDomain: "known.test", sourceUrl: "https://jobs.lever.co/known", discoveredFrom: { channel: "legacy", reference: "seed" } },
  ]));

  const report = await discoverCommonCrawlSources(candidatesPath, reportPath, {
    country: "IN",
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("collinfo.json")) return Response.json([{ id: "CC-MAIN-TEST", "cdx-api": "https://index.test/CC-MAIN-TEST-index" }]);
      if (url.includes("jobs.lever.co")) return new Response([
        JSON.stringify({ url: "https://jobs.lever.co/known/123" }),
        JSON.stringify({ url: "https://jobs.lever.co/newco/456" }),
      ].join("\n"));
      if (url.includes("greenhouse")) return new Response(`${JSON.stringify({ url: "https://boards.greenhouse.io/acme/jobs/1" })}\n${JSON.stringify({ url: "https://job-boards.greenhouse.io/acme" })}`);
      if (url.includes("myworkdayjobs")) return new Response(JSON.stringify({ url: "https://mastercard.wd1.myworkdayjobs.com/en-US/CorporateCareers/job/Pune-India/Engineer_R-1" }));
      return new Response("");
    },
  });

  expect(report).toEqual(expect.objectContaining({ country: "IN", urlsSeen: 5, sourcesFound: 4, alreadyKnown: 1, unresolved: 3, rejected: 0, truncated: false }));
  expect(report.leads.map((lead) => lead.sourceUrl).sort()).toEqual([
    "https://job-boards.greenhouse.io/acme",
    "https://jobs.lever.co/newco",
    "https://mastercard.wd1.myworkdayjobs.com/en-US/CorporateCareers",
  ]);
  expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);
});
