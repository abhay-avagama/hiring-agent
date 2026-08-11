#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { traceCareerSources } from "../src/career-tracing.ts";

export interface CareerSeed { companyName: string; companyDomain: string; careerUrl: string }

interface Options {
  country: string;
  input: string;
  candidates: string;
  catalog: string;
  registry: string;
  dataDir: string;
  commonCrawlReport?: string;
  batchSize: number;
  traceConcurrency: number;
  verifyConcurrency: number;
  workdayConcurrency: number;
  crawlConcurrency: number;
  skipVerify: boolean;
  skipCrawl: boolean;
}

const THIRD_PARTY_HOSTS = [
  "linkedin.com", "naukri.com", "instahyre.com", "angel.co", "wellfound.com", "github.com",
  "jobs.lever.co", "jobs.ashbyhq.com", "job-boards.greenhouse.io", "boards.greenhouse.io",
];

export function parseCareerPageMarkdown(markdown: string): { seeds: CareerSeed[]; skipped: number } {
  const seeds = new Map<string, CareerSeed>();
  let skipped = 0;
  for (const match of markdown.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/giu)) {
    const [, href, label] = match;
    try {
      const url = new URL(href!);
      if (url.protocol !== "https:" || isThirdParty(url.hostname)) { skipped += 1; continue; }
      const companyName = decodeEntities(label!).replace(/\s+/gu, " ").trim();
      if (!companyName || companyName.length > 120) { skipped += 1; continue; }
      const companyDomain = companyOwnedDomain(url.hostname);
      const key = `${companyName.toLocaleLowerCase()}|${url.href}`;
      seeds.set(key, { companyName, companyDomain, careerUrl: url.href });
    } catch { skipped += 1; }
  }
  return { seeds: [...seeds.values()], skipped };
}

export function chunkSeeds(seeds: CareerSeed[], size: number): CareerSeed[][] {
  const chunks: CareerSeed[][] = [];
  for (let index = 0; index < seeds.length; index += size) chunks.push(seeds.slice(index, index + size));
  return chunks;
}

async function main() {
  if (process.argv[2] === "--trace-batch") return traceBatch(process.argv.slice(3));
  const options = parseOptions(process.argv.slice(2));
  const before = await corpusMetrics(options.catalog, join(options.dataDir, "snapshot.json"), options.country);
  const parsed = parseCareerPageMarkdown(await readFile(options.input, "utf8"));
  const campaignDir = join(options.dataDir, "expansion", `${options.country.toLowerCase()}-career-pages`);
  await mkdir(campaignDir, { recursive: true });
  const batches = chunkSeeds(parsed.seeds, options.batchSize);
  console.log(JSON.stringify({ phase: "seed", input: options.input, accepted: parsed.seeds.length, skipped: parsed.skipped, batches: batches.length }));

  let traceFailures = 0;
  for (const [index, batch] of batches.entries()) {
    const batchPath = join(campaignDir, `batch-${String(index).padStart(3, "0")}.json`);
    const reportPath = join(campaignDir, `batch-${String(index).padStart(3, "0")}-report.json`);
    await writeFile(batchPath, `${JSON.stringify(batch, null, 2)}\n`, "utf8");
    const args = ["run", import.meta.path, "--trace-batch", batchPath, reportPath, options.candidates, options.registry, options.country, String(options.traceConcurrency)];
    if (options.commonCrawlReport) args.push(options.commonCrawlReport);
    const status = await run(process.execPath, args);
    if (status !== 0) { traceFailures += 1; console.error(JSON.stringify({ phase: "trace", batch: index, status: "failed", exitCode: status })); }
  }

  if (!options.skipVerify) {
    await requireSuccess(process.execPath, ["run", "src/cli.ts", "sources", "verify", options.candidates,
      "--output", options.catalog, "--registry", options.registry, "--require-country", options.country,
      "--limit", "100000", "--concurrency", String(options.verifyConcurrency), "--workday-concurrency", String(options.workdayConcurrency), "--retry-deferred"]);
  }
  if (!options.skipCrawl) {
    await requireSuccess(process.execPath, ["run", "src/cli.ts", "crawl", "--country", options.country,
      "--concurrency", String(options.crawlConcurrency), "--data-dir", options.dataDir]);
  }
  const after = await corpusMetrics(options.catalog, join(options.dataDir, "snapshot.json"), options.country);
  console.log(JSON.stringify({ phase: "complete", country: options.country, traceFailures, before, after,
    delta: { companies: after.companies - before.companies, jobs: after.jobs - before.jobs, countryJobs: after.countryJobs - before.countryJobs } }, null, 2));
}

async function traceBatch(args: string[]) {
  const [input, report, candidates, registry, country, concurrency, commonCrawlReport] = args;
  if (!input || !report || !candidates || !registry || !country || !concurrency) throw new Error("Invalid trace batch invocation");
  const result = await traceCareerSources(input, candidates, report, {
    country, concurrency: Number(concurrency), registryPath: registry,
    ...(commonCrawlReport ? { commonCrawlReportPath: commonCrawlReport } : {}),
  });
  console.log(JSON.stringify({ phase: "trace", batch: basename(input), ready: result.ready, matched: result.matched,
    unresolved: result.unresolved, failures: result.failures, registryAdded: result.registryAdded }));
  process.exit(0);
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    country: "IN", input: "data/companies-career-page.md", candidates: "data/source-candidates.json",
    catalog: "data/companies.json", registry: "data/enrichment-leads.json", dataDir: ".openings",
    batchSize: 10, traceConcurrency: 10, verifyConcurrency: 10, workdayConcurrency: 5, crawlConcurrency: 10,
    skipVerify: false, skipCrawl: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--skip-verify") options.skipVerify = true;
    else if (flag === "--skip-crawl") options.skipCrawl = true;
    else {
      const value = args[++index];
      if (!value) throw new Error(`${flag} requires a value`);
      if (flag === "--country") options.country = value.toUpperCase();
      else if (flag === "--input") options.input = value;
      else if (flag === "--candidates") options.candidates = value;
      else if (flag === "--catalog") options.catalog = value;
      else if (flag === "--registry") options.registry = value;
      else if (flag === "--data-dir") options.dataDir = value;
      else if (flag === "--common-crawl-report") options.commonCrawlReport = value;
      else if (flag === "--batch-size") options.batchSize = positiveInteger(value, flag, 100);
      else if (flag === "--trace-concurrency") options.traceConcurrency = positiveInteger(value, flag, 100);
      else if (flag === "--verify-concurrency") options.verifyConcurrency = positiveInteger(value, flag, 100);
      else if (flag === "--workday-concurrency") options.workdayConcurrency = positiveInteger(value, flag, 10);
      else if (flag === "--crawl-concurrency") options.crawlConcurrency = positiveInteger(value, flag, 100);
      else throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (!/^[A-Z]{2}$/u.test(options.country)) throw new Error("--country requires a two-letter country code");
  options.input = resolve(options.input); options.candidates = resolve(options.candidates); options.catalog = resolve(options.catalog);
  options.registry = resolve(options.registry); options.dataDir = resolve(options.dataDir);
  if (options.commonCrawlReport) options.commonCrawlReport = resolve(options.commonCrawlReport);
  return options;
}

function positiveInteger(value: string, flag: string, maximum: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) throw new Error(`${flag} must be an integer from 1 to ${maximum}`);
  return number;
}

function companyOwnedDomain(hostname: string): string {
  const labels = hostname.toLocaleLowerCase().replace(/\.$/u, "").split(".");
  if (["www", "careers", "career", "jobs"].includes(labels[0]!) && labels.length > 2) labels.shift();
  return labels.join(".");
}

function isThirdParty(hostname: string): boolean {
  const value = hostname.toLocaleLowerCase();
  return THIRD_PARTY_HOSTS.some((domain) => value === domain || value.endsWith(`.${domain}`)) || /\.wd\d+\.myworkdayjobs\.com$/u.test(value);
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/giu, "&").replace(/&#39;/giu, "'").replace(/&quot;/giu, "\"").replace(/&nbsp;/giu, " ");
}

async function run(command: string, args: string[]): Promise<number> {
  const child = Bun.spawn([command, ...args], { cwd: process.cwd(), stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  return child.exited;
}

async function requireSuccess(command: string, args: string[]) {
  const status = await run(command, args);
  if (status !== 0) throw new Error(`Command failed (${status}): ${command} ${args.join(" ")}`);
}

async function corpusMetrics(catalogPath: string, snapshotPath: string, country: string): Promise<{ companies: number; jobs: number; countryJobs: number }> {
  let companies = 0; let jobs = 0; let countryJobs = 0;
  try { companies = Object.keys(JSON.parse(await readFile(catalogPath, "utf8")) as object).length; } catch {}
  try {
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as { partitions?: Record<string, { jobs?: Array<{ eligibleCountries?: string[] }> }> };
    for (const partition of Object.values(snapshot.partitions ?? {})) for (const job of partition.jobs ?? []) {
      jobs += 1; if (job.eligibleCountries?.includes(country)) countryJobs += 1;
    }
  } catch {}
  return { companies, jobs, countryJobs };
}

if (import.meta.main) await main();
