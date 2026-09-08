import { readFile } from "node:fs/promises";
import { atomicJson } from "./atomic-file.ts";
import { crawlSite, sitePostingsToJobs, type SiteSeed } from "./jobposting-site.ts";

export interface SiteProbeOptions { limit?: number; sample?: number; concurrency?: number; maxPages?: number; delayMs?: number; timeoutMs?: number }
export interface SiteProbeReport {
  generatedAt: string; seeds: number; checked: number; withCareersPage: number; withPostings: number; robotsBlocked: number;
  postings: number; indiaPostings: number; withDate: number; withIdentifier: number; pagesFetched: number;
  sites: Array<{ companyName: string; companyDomain: string; careerUrl?: string; candidatePages: number; pagesFetched: number; postings: number; indiaPostings: number; robotsBlocked: boolean; issues: number }>;
}

/** Bounded yield measurement over company seeds: how many company sites publish JobPosting markup, and how many roles that is. */
export async function probeSites(inputPath: string, reportPath: string, options: SiteProbeOptions = {}): Promise<SiteProbeReport> {
  const all = JSON.parse(await readFile(inputPath, "utf8")) as SiteSeed[];
  const byDomain = new Map<string, SiteSeed>();
  for (const seed of all) if (seed.companyDomain && !byDomain.has(seed.companyDomain)) byDomain.set(seed.companyDomain, seed);
  let seeds = [...byDomain.values()];
  if (options.sample && options.sample < seeds.length) { let state = 12345; const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648; seeds = [...seeds].sort(() => random() - 0.5).slice(0, options.sample); }
  if (options.limit) seeds = seeds.slice(0, options.limit);
  const report: SiteProbeReport = { generatedAt: new Date().toISOString(), seeds: all.length, checked: 0, withCareersPage: 0, withPostings: 0, robotsBlocked: 0, postings: 0, indiaPostings: 0, withDate: 0, withIdentifier: 0, pagesFetched: 0, sites: [] };
  let cursor = 0;
  async function worker() {
    while (cursor < seeds.length) {
      const seed = seeds[cursor++]!;
      const result = await crawlSite(seed, { maxPages: options.maxPages, delayMs: options.delayMs ?? 300, timeoutMs: options.timeoutMs }).catch((error) => ({ robotsBlocked: false, candidatePages: 0, pagesFetched: 0, postings: [], issues: [String(error)], careerUrl: undefined }));
      const jobs = sitePostingsToJobs({ slug: seed.companyDomain, name: seed.companyName }, result.postings);
      const india = jobs.filter((job) => job.eligibleCountries.includes("IN")).length;
      report.checked += 1;
      if (result.careerUrl) report.withCareersPage += 1;
      if (result.postings.length) report.withPostings += 1;
      if (result.robotsBlocked) report.robotsBlocked += 1;
      report.postings += result.postings.length; report.indiaPostings += india; report.pagesFetched += result.pagesFetched;
      report.withDate += result.postings.filter((posting) => posting.datePosted).length;
      report.withIdentifier += result.postings.filter((posting) => posting.identifier).length;
      report.sites.push({ companyName: seed.companyName, companyDomain: seed.companyDomain, careerUrl: result.careerUrl, candidatePages: result.candidatePages, pagesFetched: result.pagesFetched, postings: result.postings.length, indiaPostings: india, robotsBlocked: result.robotsBlocked, issues: result.issues.length });
      if (report.checked % 25 === 0) await atomicJson(reportPath, report);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 6) }, worker));
  report.sites.sort((left, right) => right.postings - left.postings);
  await atomicJson(reportPath, report);
  return report;
}
