#!/usr/bin/env bun
import { mkdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { atomicJson } from "../src/atomic-file.ts";
import { traceCareerSources } from "../src/career-tracing.ts";
import { isEligibleForCountry } from "../src/locations.ts";
import type { Job } from "../src/types.ts";

export interface CareerSeed { companyName: string; companyDomain: string; careerUrl: string }

export interface Options {
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
  crawlDelayMs: number;
  workdayPageDelayMs: number;
  sourceCacheHours: number;
  sourceLimit: number;
  skipTrace: boolean;
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
  const links = [
    ...[...markdown.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/giu)].map((match) => [match[1]!, match[2]!] as const),
    ...[...markdown.matchAll(/(?<!!)\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/giu)].map((match) => [match[2]!, match[1]!] as const),
  ];
  for (const [href, label] of links) {
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
  let crashedBatches = 0;
  let traceRequestFailures = 0;
  if (options.skipTrace) console.log(JSON.stringify({ phase: "trace", status: "skipped" }));
  else {
    const input = await readFile(options.input, "utf8");
    const parsed = parseCareerPageMarkdown(input);
    if (input.trim() && !parsed.seeds.length) throw new Error(`No usable company-owned HTTPS career links found in ${options.input}`);
    const campaignDir = join(options.dataDir, "expansion", `${options.country.toLowerCase()}-career-pages`);
    await mkdir(campaignDir, { recursive: true });
    const batches = chunkSeeds(parsed.seeds, options.batchSize);
    console.log(JSON.stringify({ phase: "seed", input: options.input, accepted: parsed.seeds.length, skipped: parsed.skipped, batches: batches.length }));
    for (const [index, batch] of batches.entries()) {
      const batchPath = join(campaignDir, `batch-${String(index).padStart(3, "0")}.json`);
      const reportPath = join(campaignDir, `batch-${String(index).padStart(3, "0")}-report.json`);
      await atomicJson(batchPath, batch);
      const args = ["run", import.meta.path, "--trace-batch", batchPath, reportPath, options.candidates, options.registry, options.country, String(options.traceConcurrency)];
      if (options.commonCrawlReport) args.push(options.commonCrawlReport);
      const status = await run(process.execPath, args);
      if (status !== 0) { crashedBatches += 1; console.error(JSON.stringify({ phase: "trace", batch: index, status: "failed", exitCode: status })); }
      else {
        const report = JSON.parse(await readFile(reportPath, "utf8")) as { failures?: unknown };
        if (!Number.isInteger(report.failures) || (report.failures as number) < 0) throw new Error(`Invalid trace report: ${reportPath}`);
        traceRequestFailures += report.failures as number;
      }
    }
  }

  if (!options.skipVerify) {
    await requireSuccess(process.execPath, ["run", "src/cli.ts", "sources", "verify", options.candidates,
      "--output", options.catalog, "--registry", options.registry, "--require-country", options.country,
      "--limit", "100000", "--concurrency", String(options.verifyConcurrency), "--workday-concurrency", String(options.workdayConcurrency), "--retry-deferred"], "verify");
  } else console.log(JSON.stringify({ phase: "verify", status: "skipped" }));
  if (!options.skipCrawl) {
    await requireSuccess(process.execPath, ["run", "src/cli.ts", "crawl", "--country", options.country,
      "--concurrency", String(options.crawlConcurrency), "--delay-ms", String(options.crawlDelayMs),
      "--workday-page-delay-ms", String(options.workdayPageDelayMs), "--source-cache-hours", String(options.sourceCacheHours),
      "--source-limit", String(options.sourceLimit),
      "--data-dir", options.dataDir], "crawl");
  } else console.log(JSON.stringify({ phase: "crawl", status: "skipped" }));
  const after = await corpusMetrics(options.catalog, join(options.dataDir, "snapshot.json"), options.country);
  console.log(JSON.stringify({ phase: "complete", country: options.country, crashedBatches, traceRequestFailures, before, after,
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
  // Bun can retain aborted DNS/TLS handles after a bounded trace. The batch is already atomically persisted, so terminate this isolated worker explicitly.
  process.exit(0);
}

export function parseOptions(args: string[]): Options {
  const options: Options = {
    country: "IN", input: "data/companies-career-page.md", candidates: "data/source-candidates.json",
    catalog: "data/companies.json", registry: "data/enrichment-leads.json", dataDir: ".openings",
    batchSize: 10, traceConcurrency: 10, verifyConcurrency: 10, workdayConcurrency: 5, crawlConcurrency: 10, crawlDelayMs: 500,
    workdayPageDelayMs: 250,
    sourceCacheHours: 24,
    sourceLimit: 25,
    skipTrace: false, skipVerify: false, skipCrawl: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--skip-trace") options.skipTrace = true;
    else if (flag === "--skip-verify") options.skipVerify = true;
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
      else if (flag === "--crawl-delay-ms") options.crawlDelayMs = nonNegativeInteger(value, flag, 60_000);
      else if (flag === "--workday-page-delay-ms") options.workdayPageDelayMs = nonNegativeInteger(value, flag, 60_000);
      else if (flag === "--source-cache-hours") options.sourceCacheHours = nonNegativeNumber(value, flag, 8760);
      else if (flag === "--source-limit") options.sourceLimit = nonNegativeInteger(value, flag, 100_000);
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

function nonNegativeInteger(value: string, flag: string, maximum: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > maximum) throw new Error(`${flag} must be an integer from 0 to ${maximum}`);
  return number;
}

function nonNegativeNumber(value: string, flag: string, maximum: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > maximum) throw new Error(`${flag} must be a number from 0 to ${maximum}`);
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

async function requireSuccess(command: string, args: string[], phase: "verify" | "crawl") {
  return runPhase(phase, () => run(command, args));
}

export async function runPhase(phase: "verify" | "crawl", operation: () => Promise<number>, write: (event: Record<string, unknown>) => void = (event) => console.log(JSON.stringify(event))) {
  const startedAt = Date.now();
  write({ phase, status: "starting" });
  const heartbeat = setInterval(() => write({ phase, status: "running", elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) }), 15_000);
  let status: number;
  try { status = await operation(); }
  catch (error) {
    write({ phase, status: "failed", elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000), error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally { clearInterval(heartbeat); }
  const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
  if (status !== 0) {
    write({ phase, status: "failed", elapsedSeconds, exitCode: status });
    throw new Error(`${phase} command failed with exit code ${status}`);
  }
  write({ phase, status: "completed", elapsedSeconds });
}

export async function corpusMetrics(catalogPath: string, snapshotPath: string, country: string): Promise<{ companies: number; jobs: number; countryJobs: number }> {
  let companies = 0; let jobs = 0; let countryJobs = 0;
  const catalog = await readJsonIfPresent(catalogPath);
  if (catalog !== undefined) companies = Object.keys(catalog as object).length;
  const value = await readJsonIfPresent(snapshotPath);
  if (value !== undefined) {
    const snapshot = value as { partitions?: Record<string, { jobs?: Job[] }> };
    for (const partition of Object.values(snapshot.partitions ?? {})) for (const job of partition.jobs ?? []) {
      jobs += 1; if (isEligibleForCountry(job, country)) countryJobs += 1;
    }
  }
  return { companies, jobs, countryJobs };
}

async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

if (import.meta.main) await main();
