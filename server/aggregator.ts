#!/usr/bin/env bun
// Openings aggregator: receives crawl reports from installs, keeps a job history, and publishes a merged snapshot.
// ponytail: single Bun process over SQLite; no auth or rate limiting. Add a shared token check on POST if abuse appears.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { companies } from "../src/index.ts";
import type { CrawlReportPayload } from "../src/crawl-reporting.ts";
import type { Ats, Company, Job, JobSnapshot } from "../src/types.ts";

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_JOBS_PER_REPORT = 10_000;
const MAX_REPORT_AGE_MS = 30 * 86_400_000;
const providerHosts: Record<Ats, string> = { greenhouse: "greenhouse.io", lever: "lever.co", ashby: "ashbyhq.com", workday: "myworkdayjobs.com", recruitee: "recruitee.com" };
const workModes = new Set(["remote", "hybrid", "onsite", "unknown"]);
const confidences = new Set(["explicit", "inferred", "unknown"]);

export function createAggregator(options: { db?: Database; sources?: Company[]; now?: () => Date } = {}) {
  const db = options.db ?? new Database(":memory:");
  const sources = new Map((options.sources ?? companies).map((company) => [company.slug, company]));
  const now = options.now ?? (() => new Date());
  db.exec(`
    CREATE TABLE IF NOT EXISTS crawls (id INTEGER PRIMARY KEY, slug TEXT NOT NULL, fetched_at TEXT NOT NULL, received_at TEXT NOT NULL, jobs INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS crawls_slug ON crawls (slug, fetched_at);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, slug TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, reports INTEGER NOT NULL, job TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS jobs_slug ON jobs (slug, last_seen_at);
    CREATE INDEX IF NOT EXISTS jobs_first_seen ON jobs (first_seen_at);
  `);
  const insertCrawl = db.prepare("INSERT INTO crawls (slug, fetched_at, received_at, jobs) VALUES (?, ?, ?, ?)");
  const exists = db.prepare("SELECT 1 FROM jobs WHERE id = ?");
  const upsertJob = db.prepare(`
    INSERT INTO jobs (id, slug, first_seen_at, last_seen_at, reports, job) VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT (id) DO UPDATE SET
      reports = jobs.reports + 1,
      job = CASE WHEN excluded.last_seen_at >= jobs.last_seen_at THEN excluded.job ELSE jobs.job END,
      last_seen_at = MAX(jobs.last_seen_at, excluded.last_seen_at)`);
  const ingest = db.transaction((slug: string, fetchedAt: string, jobs: Job[]) => {
    insertCrawl.run(slug, fetchedAt, now().toISOString(), jobs.length);
    let created = 0;
    for (const job of jobs) {
      if (!exists.get(job.id)) created += 1;
      upsertJob.run(job.id, slug, fetchedAt, fetchedAt, JSON.stringify(job));
    }
    return created;
  });

  function exportSnapshot(): JobSnapshot {
    const rows = db.query<{ slug: string; fetched_at: string; job: string }, []>(`
      SELECT j.slug, c.fetched_at, j.job FROM jobs j
      JOIN (SELECT slug, MAX(fetched_at) AS fetched_at FROM crawls GROUP BY slug) c ON c.slug = j.slug AND j.last_seen_at >= c.fetched_at
      ORDER BY j.slug, j.id`).all();
    const partitions: JobSnapshot["partitions"] = {};
    for (const row of rows) (partitions[row.slug] ??= { fetchedAt: row.fetched_at, jobs: [] }).jobs.push(JSON.parse(row.job) as Job);
    const stamp = now().toISOString();
    const count = Object.keys(partitions).length;
    return { version: 1, updatedAt: stamp, partitions, lastCrawl: { startedAt: stamp, finishedAt: stamp, selected: count, succeeded: count, failed: [] } };
  }

  function digest(days: number, country: string | undefined, limit: number): string {
    const since = new Date(now().getTime() - days * 86_400_000).toISOString();
    const rows = db.query<{ job: string; first_seen_at: string }, [string]>("SELECT job, first_seen_at FROM jobs WHERE first_seen_at >= ? ORDER BY first_seen_at DESC, id").all(since);
    const jobs = rows.map((row) => JSON.parse(row.job) as Job)
      .filter((job) => job.eligibilityConfidence !== "unknown" && (!country || job.eligibleCountries.includes(country)))
      .slice(0, limit);
    const heading = `# New jobs${country ? ` in ${country}` : ""} (last ${days} day${days === 1 ? "" : "s"})`;
    if (!jobs.length) return `${heading}\n\nNo new jobs.\n`;
    return `${heading}\n\n${jobs.map((job) => `- **${job.title}** at ${job.company} · ${job.location}${job.remote ? " · Remote" : ""}\n  ${job.url}`).join("\n")}\n`;
  }

  async function readReport(request: Request): Promise<unknown> {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) throw new HttpError(413, "Report too large");
    let bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES) throw new HttpError(413, "Report too large");
    if (request.headers.get("content-encoding") === "gzip") bytes = Bun.gunzipSync(bytes);
    if (bytes.byteLength > MAX_BODY_BYTES) throw new HttpError(413, "Report too large");
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400, "Report must be JSON"); }
  }

  function validateReport(value: unknown): { source: Company; fetchedAt: string; jobs: Job[]; rejected: number } {
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.source) || !Array.isArray(value.jobs)) throw new HttpError(400, "Malformed crawl report");
    const source = typeof value.source.slug === "string" ? sources.get(value.source.slug) : undefined;
    if (!source) throw new HttpError(400, "Unknown source; only verified catalog sources are accepted");
    if (value.source.ats !== source.ats || value.source.token !== source.token) throw new HttpError(400, "Source identity does not match the catalog");
    const fetchedAt = typeof value.fetchedAt === "string" ? Date.parse(value.fetchedAt) : Number.NaN;
    if (!Number.isFinite(fetchedAt) || fetchedAt > now().getTime() + 300_000 || fetchedAt < now().getTime() - MAX_REPORT_AGE_MS) throw new HttpError(400, "fetchedAt must be a recent ISO timestamp");
    if (value.jobs.length > MAX_JOBS_PER_REPORT) throw new HttpError(413, "Too many jobs in one report");
    const jobs: Job[] = [];
    for (const item of value.jobs) { const job = validateJob(item, source); if (job) jobs.push(job); }
    return { source, fetchedAt: new Date(fetchedAt).toISOString(), jobs, rejected: value.jobs.length - jobs.length };
  }

  return {
    exportSnapshot,
    digest,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      try {
        if (request.method === "GET" && url.pathname === "/healthz") {
          const stats = db.query<{ jobs: number; sources: number }, []>("SELECT (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT COUNT(DISTINCT slug) FROM crawls) AS sources").get()!;
          return Response.json({ ok: true, ...stats });
        }
        if (request.method === "POST" && url.pathname === "/v1/crawls") {
          const report = validateReport(await readReport(request));
          const created = ingest(report.source.slug, report.fetchedAt, report.jobs);
          return Response.json({ accepted: report.jobs.length, created, rejected: report.rejected });
        }
        if (request.method === "GET" && url.pathname === "/v1/snapshot") {
          const body = JSON.stringify(exportSnapshot());
          if (request.headers.get("accept-encoding")?.includes("gzip")) {
            return new Response(Bun.gzipSync(body), { headers: { "content-type": "application/json", "content-encoding": "gzip" } });
          }
          return new Response(body, { headers: { "content-type": "application/json" } });
        }
        if (request.method === "GET" && url.pathname === "/v1/digest") {
          const days = clamp(Number(url.searchParams.get("days") ?? 1), 1, 30);
          const limit = clamp(Number(url.searchParams.get("limit") ?? 25), 1, 200);
          const country = url.searchParams.get("country")?.toUpperCase() || undefined;
          if (country && !/^[A-Z]{2}$/.test(country)) throw new HttpError(400, "country must be a two-letter code");
          return new Response(digest(days, country, limit), { headers: { "content-type": "text/markdown; charset=utf-8" } });
        }
        return Response.json({ error: "Not found" }, { status: 404 });
      } catch (error) {
        if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
        return Response.json({ error: "Internal error" }, { status: 500 });
      }
    },
  };
}

function validateJob(value: unknown, source: Company): Job | null {
  if (!isRecord(value)) return null;
  const strings = ["id", "company", "title", "location", "url", "description"] as const;
  for (const key of strings) if (typeof value[key] !== "string") return null;
  const id = value.id as string;
  if (!id.startsWith(`${source.ats}:${source.slug}:`) || !(value.title as string).trim()) return null;
  if (!urlBelongsToSource(value.url as string, source)) return null;
  if (typeof value.remote !== "boolean" || !workModes.has(value.workMode as string) || !confidences.has(value.eligibilityConfidence as string)) return null;
  const lists = ["eligibleCountries", "excludedCountries", "eligibleRegions"] as const;
  for (const key of lists) if (!Array.isArray(value[key]) || !(value[key] as unknown[]).every((item) => typeof item === "string")) return null;
  return {
    id, company: value.company as string, title: value.title as string, location: value.location as string, remote: value.remote,
    workMode: value.workMode as Job["workMode"], eligibleCountries: value.eligibleCountries as string[], excludedCountries: value.excludedCountries as string[],
    eligibleRegions: value.eligibleRegions as string[], eligibilityConfidence: value.eligibilityConfidence as Job["eligibilityConfidence"],
    url: value.url as string, description: value.description as string, ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
  };
}

function urlBelongsToSource(value: string, source: Company): boolean {
  let host: string;
  try { const url = new URL(value); if (url.protocol !== "https:") return false; host = url.hostname.toLowerCase(); } catch { return false; }
  const allowed = [providerHosts[source.ats], source.companyDomain?.toLowerCase()].filter((entry): entry is string => Boolean(entry));
  return allowed.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  const path = process.env.OPENINGS_AGGREGATOR_DB ?? ".openings/aggregator.sqlite";
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  const server = Bun.serve({ port: Number(process.env.PORT ?? 8787), fetch: createAggregator({ db }).fetch });
  console.error(`Openings aggregator listening on ${server.url} (db: ${path})`);
}
