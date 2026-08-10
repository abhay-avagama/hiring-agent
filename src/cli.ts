#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { createRuntime } from "./runtime.ts";
import { runSourceVerification } from "./source-pipeline.ts";
import { runSourceDiscovery, runYcSourceDiscovery } from "./source-discovery.ts";
import { discoverAndPromote } from "./source-discovery-pipeline.ts";
import { traceCareerSources } from "./career-tracing.ts";
import { discoverCommonCrawlSources } from "./common-crawl-discovery.ts";
import { generateYcCompanySeeds } from "./company-seeds.ts";
import { exportSnapshot } from "./snapshot-export.ts";

const HELP = `Openings — search public company job boards

Usage:
  openings crawl [--country CODE | --companies FILE] [--concurrency N] [--data-dir PATH]
  openings snapshot export [--input FILE] [--output-dir PATH]
  openings sources verify CANDIDATES.json [--output FILE] [--concurrency N] [--require-country CODE]
  openings sources discover FEED.json [--country CODE] [--output FILE] [--catalog FILE] [--report FILE]
  openings sources discover-yc --country CODE [--output FILE] [--catalog FILE] [--report FILE]
  openings sources seed-companies-yc --country CODE [--output FILE]
  openings sources discover-common-crawl [--country CODE] [--output FILE] [--report FILE] [--index-url URL]
  openings sources trace-careers COMPANIES.json [--country CODE] [--common-crawl-report FILE] [--search-key-env NAME] [--output FILE] [--catalog FILE] [--report FILE]
  openings search [words] [--country CODE|--india] [--location PLACE] [--remote|--onsite]
                  [--limit N] [--stale-days N] [--offline] [--data-dir PATH]
  openings get JOB_ID [--stale-days N] [--offline] [--data-dir PATH]
  openings --help

Results are JSON so humans and agents can use the same command.`;

export async function run(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }

  if (command === "get") {
    const id = rest[0];
    if (!id) return fail("get requires a JOB_ID");
    const settings = parseRuntimeOptions(rest.slice(1));
    if (typeof settings === "string") return fail(settings);
    const result = await createRuntime({ dataDir: settings.dataDir }).get(id, settings);
    if (!result.job) return fail(`Job not found: ${id}`, 2);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (command === "crawl") {
    const parsed = parseCrawl(rest);
    if (typeof parsed === "string") return fail(parsed);
    const runtime = createRuntime({ dataDir: parsed.dataDir, concurrency: parsed.concurrency });
    const slugs = parsed.companiesFile ? await readCompanyFile(parsed.companiesFile) : undefined;
    console.log(JSON.stringify(await runtime.crawl({ country: parsed.country, slugs }), null, 2));
    return 0;
  }

  if (command === "snapshot") {
    if (rest[0] !== "export") return fail("snapshot requires the `export` subcommand");
    const parsed = parseSnapshotExport(rest.slice(1));
    if (typeof parsed === "string") return fail(parsed);
    console.log(JSON.stringify(await exportSnapshot(parsed.input, parsed.outputDir), null, 2));
    return 0;
  }

  if (command === "sources") {
    if (rest[0] === "seed-companies-yc") {
      const parsed = parseYcCompanySeeds(rest.slice(1));
      if (typeof parsed === "string") return fail(parsed);
      console.log(JSON.stringify(await generateYcCompanySeeds(parsed.output, parsed), null, 2));
      return 0;
    }
    if (rest[0] === "trace-careers") {
      const parsed = parseCareerTracing(rest.slice(1));
      if (typeof parsed === "string") return fail(parsed);
      const discovery = await traceCareerSources(parsed.inputPath, parsed.output, parsed.report, parsed);
      const promotion = await runSourceVerification(parsed.output, parsed.catalog, parsed);
      console.log(JSON.stringify({ discovery: compactCareerTraceReport(discovery), promotion }, null, 2));
      return 0;
    }
    if (rest[0] === "discover-common-crawl") {
      const parsed = parseCommonCrawlDiscovery(rest.slice(1));
      if (typeof parsed === "string") return fail(parsed);
      console.log(JSON.stringify(compactCommonCrawlReport(await discoverCommonCrawlSources(parsed.output, parsed.report, parsed)), null, 2));
      return 0;
    }
    if (rest[0] === "discover-yc") {
      const parsed = parseYcDiscovery(rest.slice(1));
      if (typeof parsed === "string") return fail(parsed);
      console.log(JSON.stringify(compactDiscoveryPromotion(await discoverAndPromote(
        () => runYcSourceDiscovery(parsed.output, parsed.report, parsed), parsed.output, parsed.catalog, parsed,
      )), null, 2));
      return 0;
    }
    if (rest[0] === "discover") {
      const parsed = parseSourceDiscovery(rest.slice(1));
      if (typeof parsed === "string") return fail(parsed);
      console.log(JSON.stringify(compactDiscoveryPromotion(await discoverAndPromote(
        () => runSourceDiscovery(parsed.feedPath, parsed.output, parsed.report, parsed), parsed.output, parsed.catalog, parsed,
      )), null, 2));
      return 0;
    }
    if (rest[0] !== "verify") return fail("sources requires a discovery, tracing, or `verify` subcommand");
    const parsed = parseSourceVerification(rest.slice(1));
    if (typeof parsed === "string") return fail(parsed);
    console.log(JSON.stringify(await runSourceVerification(parsed.candidatesPath, parsed.output, { concurrency: parsed.concurrency, requireCountry: parsed.requireCountry }), null, 2));
    return 0;
  }

  if (command === "search") {
    const parsed = parseSearch(rest);
    if (typeof parsed === "string") return fail(parsed);
    const runtime = createRuntime({ dataDir: parsed.dataDir });
    const result = await runtime.search(parsed.query, parsed);
    console.log(JSON.stringify({ jobs: result.jobs, count: result.jobs.length, snapshot: result.snapshot }, null, 2));
    return 0;
  }

  return fail(`Unknown command: ${command}`);
}

function parseYcCompanySeeds(args: string[]) {
  let output = ".openings/company-domains.json";
  let country: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--country") { country = parseCountry(args[++index]); if (!country) return "--country requires a two-letter country code"; }
    else if (arg === "--output") { output = args[++index] ?? ""; if (!output) return "--output requires a file"; }
    else return `Unknown option: ${arg}`;
  }
  if (!country) return "sources seed-companies-yc requires --country CODE";
  return { country, output };
}

function parseSnapshotExport(args: string[]) {
  let input = ".openings/snapshot.json";
  let outputDir = ".openings/dist";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--input") { input = args[++index] ?? ""; if (!input) return "--input requires a file"; }
    else if (arg === "--output-dir") { outputDir = args[++index] ?? ""; if (!outputDir) return "--output-dir requires a path"; }
    else return `Unknown option: ${arg}`;
  }
  return { input, outputDir };
}

function parseCareerTracing(args: string[]) {
  const inputPath = args[0];
  if (!inputPath || inputPath.startsWith("--")) return "sources trace-careers requires a company JSON file";
  const parsed = parseDiscoveryOutputs(args.slice(1), ".openings/career-trace-report.json", true);
  return typeof parsed === "string" ? parsed : { inputPath, ...parsed };
}

function parseCommonCrawlDiscovery(args: string[]) {
  let output = "data/source-candidates.json";
  let report = ".openings/common-crawl-discovery-report.json";
  let country: string | undefined;
  let indexUrl: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--country") { country = parseCountry(args[++index]); if (!country) return "--country requires a two-letter country code"; }
    else if (arg === "--output") { output = args[++index] ?? ""; if (!output) return "--output requires a file"; }
    else if (arg === "--report") { report = args[++index] ?? ""; if (!report) return "--report requires a file"; }
    else if (arg === "--index-url") { indexUrl = args[++index]; if (!indexUrl) return "--index-url requires a URL"; try { new URL(indexUrl); } catch { return "--index-url requires a valid URL"; } }
    else return `Unknown option: ${arg}`;
  }
  return { output, report, country, indexUrl };
}

function parseDiscoveryOutputs(args: string[], defaultReport: string, requireCatalog: boolean) {
  let output = "data/source-candidates.json";
  let report = defaultReport;
  let catalog = "data/companies.json";
  let country: string | undefined;
  let concurrency = 10;
  let searchKey: string | undefined;
  let commonCrawlReportPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--country") { country = parseCountry(args[++index]); if (!country) return "--country requires a two-letter country code"; }
    else if (arg === "--output") { output = args[++index] ?? ""; if (!output) return "--output requires a file"; }
    else if (arg === "--report") { report = args[++index] ?? ""; if (!report) return "--report requires a file"; }
    else if (arg === "--catalog" && requireCatalog) { catalog = args[++index] ?? ""; if (!catalog) return "--catalog requires a file"; }
    else if (arg === "--search-key-env") {
      const name = args[++index];
      if (!name) return "--search-key-env requires an environment variable name";
      searchKey = process.env[name];
      if (!searchKey) return `Environment variable ${name} is not set`;
    }
    else if (arg === "--common-crawl-report") {
      commonCrawlReportPath = args[++index];
      if (!commonCrawlReportPath) return "--common-crawl-report requires a file";
    }
    else if (arg === "--concurrency") { concurrency = Number(args[++index]); if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) return "--concurrency must be an integer from 1 to 100"; }
    else return `Unknown option: ${arg}`;
  }
  return { output, report, catalog, country, concurrency, searchKey, commonCrawlReportPath };
}

function parseYcDiscovery(args: string[]) {
  let output = "data/source-candidates.json";
  let report = ".openings/yc-discovery-report.json";
  let catalog = "data/companies.json";
  let country: string | undefined;
  let concurrency = 10;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--country") {
      country = parseCountry(args[++index]);
      if (!country) return "--country requires a two-letter country code";
    } else if (arg === "--output") output = args[++index] ?? "";
    else if (arg === "--catalog") catalog = args[++index] ?? "";
    else if (arg === "--report") report = args[++index] ?? "";
    else if (arg === "--concurrency") {
      concurrency = Number(args[++index]);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) return "--concurrency must be an integer from 1 to 100";
    } else return `Unknown option: ${arg}`;
  }
  if (!country) return "sources discover-yc requires --country CODE";
  if (!output) return "--output requires a file";
  if (!report) return "--report requires a file";
  if (!catalog) return "--catalog requires a file";
  return { output, report, catalog, country, concurrency };
}

function parseSourceDiscovery(args: string[]) {
  const feedPath = args[0];
  if (!feedPath || feedPath.startsWith("--")) return "sources discover requires a feed JSON file";
  let output = "data/source-candidates.json";
  let report = ".openings/discovery-report.json";
  let catalog = "data/companies.json";
  let country: string | undefined;
  let concurrency = 10;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--country") {
      country = parseCountry(args[++index]);
      if (!country) return "--country requires a two-letter country code";
    } else if (arg === "--output") {
      output = args[++index] ?? "";
      if (!output) return "--output requires a file";
    } else if (arg === "--report") {
      report = args[++index] ?? "";
      if (!report) return "--report requires a file";
    } else if (arg === "--catalog") {
      catalog = args[++index] ?? "";
      if (!catalog) return "--catalog requires a file";
    } else if (arg === "--concurrency") {
      concurrency = Number(args[++index]);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) return "--concurrency must be an integer from 1 to 100";
    } else return `Unknown option: ${arg}`;
  }
  return { feedPath, output, report, catalog, country, concurrency };
}

function parseSearch(args: string[]) {
  const queryWords: string[] = [];
  let location: string | undefined;
  let country: string | undefined;
  let remote: boolean | undefined;
  let limit: number | undefined;
  let offline = false;
  let staleDays = 14;
  let dataDir: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--location") {
      location = args[++index];
      if (!location) return "--location requires a value";
    } else if (arg === "--country") {
      country = parseCountry(args[++index]);
      if (!country) return "--country requires a two-letter country code";
    } else if (arg === "--remote") remote = true;
    else if (arg === "--india") country = "IN";
    else if (arg === "--onsite") remote = false;
    else if (arg === "--offline") offline = true;
    else if (arg === "--stale-days") {
      staleDays = Number(args[++index]);
      if (!Number.isFinite(staleDays) || staleDays < 0) return "--stale-days must be zero or greater";
    } else if (arg === "--data-dir") {
      dataDir = args[++index];
      if (!dataDir) return "--data-dir requires a value";
    }
    else if (arg === "--limit") {
      limit = Number(args[++index]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return "--limit must be an integer from 1 to 100";
    } else if (arg?.startsWith("--")) return `Unknown option: ${arg}`;
    else if (arg) queryWords.push(arg);
  }

  return { query: { query: queryWords.join(" ") || undefined, location, country, remote, limit }, offline, staleDays, dataDir };
}

function parseRuntimeOptions(args: string[]) {
  let offline = false;
  let staleDays = 14;
  let dataDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--offline") offline = true;
    else if (arg === "--stale-days") {
      staleDays = Number(args[++index]);
      if (!Number.isFinite(staleDays) || staleDays < 0) return "--stale-days must be zero or greater";
    } else if (arg === "--data-dir") {
      dataDir = args[++index];
      if (!dataDir) return "--data-dir requires a value";
    } else return `Unknown option: ${arg}`;
  }
  return { offline, staleDays, dataDir };
}

function parseCrawl(args: string[]) {
  let country: string | undefined;
  let companiesFile: string | undefined;
  let dataDir: string | undefined;
  let concurrency = 10;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--country") {
      country = parseCountry(args[++index]);
      if (!country) return "--country requires a two-letter country code";
    } else if (arg === "--companies") companiesFile = args[++index];
    else if (arg === "--data-dir") dataDir = args[++index];
    else if (arg === "--concurrency") {
      concurrency = Number(args[++index]);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) return "--concurrency must be an integer from 1 to 100";
    } else return `Unknown option: ${arg}`;
  }
  if (country && companiesFile) return "Use either --country or --companies, not both";
  if (args.includes("--companies") && !companiesFile) return "--companies requires a file";
  if (args.includes("--data-dir") && !dataDir) return "--data-dir requires a value";
  return { country, companiesFile, dataDir, concurrency };
}

function parseCountry(value: string | undefined): string | undefined {
  return value && /^[a-z]{2}$/i.test(value) ? value.toUpperCase() : undefined;
}

async function readCompanyFile(path: string): Promise<string[]> {
  return (await readFile(path, "utf8")).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

function parseSourceVerification(args: string[]) {
  const candidatesPath = args[0];
  if (!candidatesPath || candidatesPath.startsWith("--")) return "sources verify requires a candidate JSON file";
  let output = "data/companies.json";
  let concurrency = 10;
  let requireCountry: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") {
      output = args[++index] ?? "";
      if (!output) return "--output requires a file";
    } else if (arg === "--concurrency") {
      concurrency = Number(args[++index]);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) return "--concurrency must be an integer from 1 to 100";
    } else if (arg === "--require-country") {
      requireCountry = parseCountry(args[++index]);
      if (!requireCountry) return "--require-country requires a two-letter country code";
    } else return `Unknown option: ${arg}`;
  }
  return { candidatesPath, output, concurrency, requireCountry };
}

function fail(message: string, code = 1): number {
  console.error(message);
  return code;
}

function compactDiscoveryReport(report: import("./source-discovery.ts").SourceDiscoveryReport) {
  const { unresolved: _unresolved, rejections: _rejections, ...summary } = report;
  return summary;
}

function compactDiscoveryPromotion(result: import("./source-discovery-pipeline.ts").DiscoveryPromotionResult) {
  return { discovery: compactDiscoveryReport(result.discovery), promotion: result.promotion };
}

function compactCareerTraceReport(report: import("./career-tracing.ts").CareerTraceReport) {
  const { unresolvedCompanies: _unresolved, rejections: _rejections, failureDetails: _failures, ...summary } = report;
  return summary;
}

function compactCommonCrawlReport(report: import("./common-crawl-discovery.ts").CommonCrawlDiscoveryReport) {
  const { leads: _leads, rejections: _rejections, ...summary } = report;
  return summary;
}

if (import.meta.main) process.exitCode = await run(Bun.argv.slice(2));
