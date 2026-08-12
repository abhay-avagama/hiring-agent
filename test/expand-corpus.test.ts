import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkSeeds, corpusMetrics, parseCareerPageMarkdown, parseOptions, runPhase } from "../scripts/expand-corpus.ts";

describe("corpus expansion campaign", () => {
  test("extracts unique company-owned HTTPS career pages", () => {
    const result = parseCareerPageMarkdown(`
      <li><a href="https://www.acme.com/careers">Acme &amp; Co</a></li>
      <li><a href="https://www.acme.com/careers">Acme &amp; Co</a></li>
      <li><a href="http://unsafe.test/jobs">Unsafe</a></li>
      <li><a href="https://www.linkedin.com/company/acme">LinkedIn</a></li>
      <li><a href="https://acme.wd1.myworkdayjobs.com/jobs">Unverified ATS tenant</a></li>
    `);
    expect(result.seeds).toEqual([{ companyName: "Acme & Co", companyDomain: "acme.com", careerUrl: "https://www.acme.com/careers" }]);
    expect(result.skipped).toBe(3);
  });

  test("accepts ordinary Markdown career links", () => {
    expect(parseCareerPageMarkdown("- [Acme](https://careers.acme.com/openings)").seeds).toEqual([
      { companyName: "Acme", companyDomain: "acme.com", careerUrl: "https://careers.acme.com/openings" },
    ]);
  });

  test("keeps campaign batches small and deterministic", () => {
    const seeds = Array.from({ length: 5 }, (_, index) => ({ companyName: `Company ${index}`, companyDomain: `c${index}.test`, careerUrl: `https://c${index}.test/careers` }));
    expect(chunkSeeds(seeds, 2).map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(chunkSeeds(seeds, 2)[1]![0]!.companyName).toBe("Company 2");
  });

  test("supports explicit phase skipping for interrupted campaigns", () => {
    const options = parseOptions(["--country", "IN", "--skip-trace", "--skip-verify", "--crawl-delay-ms", "1000", "--workday-page-delay-ms", "250"]);
    expect(options.skipTrace).toBe(true);
    expect(options.skipVerify).toBe(true);
    expect(options.skipCrawl).toBe(false);
    expect(options.crawlDelayMs).toBe(1000);
    expect(options.workdayPageDelayMs).toBe(250);
    expect(options.sourceCacheHours).toBe(24);
    expect(options.sourceLimit).toBe(25);
  });

  test("long phases always emit a machine-readable terminal status", async () => {
    const completed: Array<Record<string, unknown>> = [];
    await runPhase("crawl", async () => 0, (event) => completed.push(event));
    expect(completed.map((event) => event.status)).toEqual(["starting", "completed"]);

    const failed: Array<Record<string, unknown>> = [];
    await expect(runPhase("verify", async () => 7, (event) => failed.push(event))).rejects.toThrow("verify command failed with exit code 7");
    expect(failed.map((event) => event.status)).toEqual(["starting", "failed"]);
    expect(failed[1]).toEqual(expect.objectContaining({ phase: "verify", exitCode: 7 }));
  });

  test("counts regional eligibility and rejects malformed state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openings-expansion-"));
    const catalog = join(directory, "companies.json");
    const snapshot = join(directory, "snapshot.json");
    try {
      await writeFile(catalog, JSON.stringify({ acme: {}, global: {} }));
      await writeFile(snapshot, JSON.stringify({ partitions: { acme: { jobs: [
        { eligibleCountries: [], excludedCountries: [], eligibleRegions: ["APAC"] },
        { eligibleCountries: [], excludedCountries: ["IN"], eligibleRegions: ["worldwide"] },
      ] } } }));
      expect(await corpusMetrics(catalog, snapshot, "IN")).toEqual({ companies: 2, jobs: 2, countryJobs: 1 });
      await writeFile(snapshot, "not json");
      await expect(corpusMetrics(catalog, snapshot, "IN")).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
