#!/usr/bin/env bun
import { catalog } from "./index.ts";

const HELP = `Openings — search public company job boards

Usage:
  openings search [words] [--india] [--location PLACE] [--remote|--onsite] [--limit N]
  openings get JOB_ID
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
    const job = await catalog.get(id);
    if (!job) return fail(`Job not found: ${id}`, 2);
    console.log(JSON.stringify(job, null, 2));
    return 0;
  }

  if (command === "search") {
    const parsed = parseSearch(rest);
    if (typeof parsed === "string") return fail(parsed);
    const jobs = await catalog.search(parsed);
    console.log(JSON.stringify({ jobs, count: jobs.length }, null, 2));
    return 0;
  }

  return fail(`Unknown command: ${command}`);
}

function parseSearch(args: string[]) {
  const queryWords: string[] = [];
  let location: string | undefined;
  let country: "IN" | undefined;
  let remote: boolean | undefined;
  let limit: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--location") {
      location = args[++index];
      if (!location) return "--location requires a value";
    } else if (arg === "--remote") remote = true;
    else if (arg === "--india") country = "IN";
    else if (arg === "--onsite") remote = false;
    else if (arg === "--limit") {
      limit = Number(args[++index]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return "--limit must be an integer from 1 to 100";
    } else if (arg?.startsWith("--")) return `Unknown option: ${arg}`;
    else if (arg) queryWords.push(arg);
  }

  return { query: queryWords.join(" ") || undefined, location, country, remote, limit };
}

function fail(message: string, code = 1): number {
  console.error(message);
  return code;
}

if (import.meta.main) process.exitCode = await run(Bun.argv.slice(2));
