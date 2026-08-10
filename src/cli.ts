#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { createRuntime } from "./runtime.ts";

const HELP = `Openings — search public company job boards

Usage:
  openings crawl [--country CODE | --companies FILE] [--concurrency N] [--data-dir PATH]
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

function fail(message: string, code = 1): number {
  console.error(message);
  return code;
}

if (import.meta.main) process.exitCode = await run(Bun.argv.slice(2));
