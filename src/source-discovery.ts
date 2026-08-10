import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveSource } from "./source-verification.ts";
import type { DiscoveryChannel, SourceCandidate } from "./types.ts";

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface DiscoveryOptions {
  country?: string;
  fetch?: Fetch;
  concurrency?: number;
  timeoutMs?: number;
}

interface FeedEntry { sourceUrl: string; companyDomain?: string; reference?: string; channel?: DiscoveryChannel; domainEvidence?: "authoritative_dataset" | "company_registry" }
interface DiscoveryIssue { sourceUrl: string; reason: string; detail: string; companyName?: string; reference?: string }

export interface SourceDiscoveryReport {
  discovered: number;
  ready: number;
  needsDomain: number;
  rejected: number;
  candidatesPath: string;
  reportPath: string;
  unresolved: DiscoveryIssue[];
  rejections: DiscoveryIssue[];
}

export async function runSourceDiscovery(feedPath: string, candidatesPath: string, reportPath: string, options: DiscoveryOptions = {}): Promise<SourceDiscoveryReport> {
  const feed = await readFeed(feedPath);
  return discoverEntries(feed, candidatesPath, reportPath, options, feedPath);
}

export async function runYcSourceDiscovery(candidatesPath: string, reportPath: string, options: DiscoveryOptions & { country: string }): Promise<SourceDiscoveryReport> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const response = await fetcher("https://yc-oss.github.io/api/companies/all.json");
  if (!response.ok) throw new Error(`YC company API returned HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error("YC company API returned an invalid payload");
  const country = options.country.toUpperCase();
  const countryName = new Intl.DisplayNames(["en"], { type: "region" }).of(country);
  if (!countryName || countryName === country) throw new Error("country must be a valid two-letter code");
  const countryPattern = new RegExp(`\\b${escapeRegExp(countryName)}\\b`, "i");
  const feed: FeedEntry[] = value.flatMap((company) => {
    if (typeof company.slug !== "string" || typeof company.website !== "string" || typeof company.all_locations !== "string" || !countryPattern.test(company.all_locations)) return [];
    let companyDomain: string;
    try { companyDomain = new URL(company.website).hostname.replace(/^www\./, ""); } catch { return []; }
    return [{
      sourceUrl: `https://job-boards.greenhouse.io/${company.slug}`,
      companyDomain,
      reference: `https://www.ycombinator.com/companies/${company.slug}`,
      domainEvidence: "authoritative_dataset",
    }];
  });
  return discoverEntries(feed, candidatesPath, reportPath, { ...options, fetch: fetcher, country }, "YC public company API");
}

async function discoverEntries(feed: FeedEntry[], candidatesPath: string, reportPath: string, options: DiscoveryOptions, feedReference: string): Promise<SourceDiscoveryReport> {
  const existing = await readCandidates(candidatesPath);
  const fetcher = options.fetch ?? globalThis.fetch;
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 10));
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 30_000));
  const country = options.country?.toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw new Error("country must be a two-letter code");
  const ready: Array<{ index: number; candidate: SourceCandidate }> = [];
  const unresolved: Array<{ index: number; issue: DiscoveryIssue }> = [];
  const rejected: Array<{ index: number; issue: DiscoveryIssue }> = [];
  const existingSources = new Set(existing.map((candidate) => sourceKey(candidate.sourceUrl)).filter(Boolean));
  let cursor = 0;

  async function worker() {
    while (cursor < feed.length) {
      const index = cursor++;
      const entry = feed[index];
      if (!entry || typeof entry.sourceUrl !== "string") {
        rejected.push({ index, issue: { sourceUrl: "", reason: "invalid_entry", detail: "sourceUrl must be a string" } });
        continue;
      }
      if (entry.companyDomain !== undefined && (typeof entry.companyDomain !== "string" || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(entry.companyDomain))) {
        rejected.push({ index, issue: issue({ sourceUrl: entry.sourceUrl }, "invalid_domain", "companyDomain must be a hostname") });
        continue;
      }
      if (entry.reference !== undefined && typeof entry.reference !== "string") {
        rejected.push({ index, issue: issue({ sourceUrl: entry.sourceUrl }, "invalid_reference", "reference must be a string") });
        continue;
      }
      const source = resolveSource(entry.sourceUrl);
      if (!source || source.ats !== "greenhouse") {
        rejected.push({ index, issue: issue(entry, "unsupported_source", "Discovery currently accepts Greenhouse source URLs") });
        continue;
      }
      if (entry.channel !== undefined && !["search", "career_page", "provider_directory", "community", "dataset"].includes(entry.channel)) {
        rejected.push({ index, issue: issue(entry, "invalid_channel", `Unsupported discovery channel: ${entry.channel}`) });
        continue;
      }
      if (entry.domainEvidence !== undefined && !["authoritative_dataset", "company_registry"].includes(entry.domainEvidence)) {
        rejected.push({ index, issue: issue(entry, "invalid_domain_evidence", `Unsupported domain evidence: ${entry.domainEvidence}`) });
        continue;
      }
      const key = `${source.ats}:${source.token.toLocaleLowerCase()}`;
      if (existingSources.has(key)) {
        rejected.push({ index, issue: issue(entry, "duplicate_source", `Duplicate of ${key}`) });
        continue;
      }
      try {
        const companyName = await observeGreenhouseName(source.token, fetcher, timeoutMs);
        if (!entry.companyDomain) {
          unresolved.push({ index, issue: { ...issue(entry, "needs_domain", "A company domain is required before verification"), companyName } });
          continue;
        }
        if (!entry.domainEvidence) {
          unresolved.push({ index, issue: { ...issue(entry, "needs_domain_evidence", "Generic feeds require authoritative domain evidence before verification"), companyName } });
          continue;
        }
        if (!domainMatchesName(entry.companyDomain, companyName)) {
          rejected.push({ index, issue: { ...issue(entry, "domain_name_mismatch", `Observed ${companyName}, which does not match ${entry.companyDomain}`), companyName } });
          continue;
        }
        ready.push({ index, candidate: {
          companyName, companyDomain: entry.companyDomain.toLocaleLowerCase(), sourceUrl: source.canonicalSourceUrl,
          cohorts: country ? [country] : undefined,
          discoveredFrom: { channel: entry.channel ?? "dataset", reference: entry.reference?.trim() || feedReference },
          domainEvidence: { kind: entry.domainEvidence, reference: entry.reference?.trim() || feedReference },
        } });
      } catch (error) {
        rejected.push({ index, issue: issue(entry, "probe_failed", error instanceof Error ? error.message : String(error)) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, feed.length) }, worker));
  const additions: SourceCandidate[] = [];
  const acceptedSources = new Set<string>();
  for (const row of ready.sort((a, b) => a.index - b.index)) {
    const key = sourceKey(row.candidate.sourceUrl)!;
    if (acceptedSources.has(key)) rejected.push({ index: row.index, issue: issue({ sourceUrl: row.candidate.sourceUrl, reference: row.candidate.discoveredFrom.reference }, "duplicate_source", `Duplicate of ${key}`) });
    else { acceptedSources.add(key); additions.push(row.candidate); }
  }
  const filteredUnresolved = unresolved.filter((row) => {
    const key = sourceKey(row.issue.sourceUrl);
    if (!key || !acceptedSources.has(key)) return true;
    rejected.push({ index: row.index, issue: { ...row.issue, reason: "duplicate_source", detail: `Duplicate of ${key}` } });
    return false;
  });
  const appended = await mergeCandidates(candidatesPath, additions);
  const report: SourceDiscoveryReport = {
    discovered: feed.length, ready: appended, needsDomain: filteredUnresolved.length, rejected: rejected.length,
    candidatesPath, reportPath,
    unresolved: filteredUnresolved.sort((a, b) => a.index - b.index).map((row) => row.issue),
    rejections: rejected.sort((a, b) => a.index - b.index).map((row) => row.issue),
  };
  await atomicJson(reportPath, report);
  return report;
}

async function observeGreenhouseName(token: string, fetcher: Fetch, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetcher(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.jobs) || body.jobs.length === 0) throw new Error("Board has no jobs to identify the company");
    const names = body.jobs.flatMap((job) => isRecord(job) && typeof job.company_name === "string" ? [job.company_name.trim()] : []);
    if (!names.length) throw new Error("Board jobs do not expose company_name");
    return majority(names);
  } finally { clearTimeout(timer); }
}

async function readFeed(path: string): Promise<FeedEntry[]> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error("Discovery feed must be a JSON array of objects");
  return value as unknown as FeedEntry[];
}

async function readCandidates(path: string): Promise<SourceCandidate[]> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(value)) throw new Error("Candidate file must contain an array");
    return value as SourceCandidate[];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function mergeCandidates(path: string, additions: SourceCandidate[]): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  return withFileLock(path, async () => {
    const current = await readCandidates(path);
    const seen = new Set(current.map((candidate) => sourceKey(candidate.sourceUrl)).filter(Boolean));
    const unique = additions.filter((candidate) => {
      const key = sourceKey(candidate.sourceUrl);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    await atomicJson(path, [...current, ...unique]);
    return unique.length;
  });
}

async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try { return await operation(); }
      finally { await handle.close(); await unlink(lockPath).catch(() => undefined); }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST") || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function sourceKey(value: string): string | undefined { const source = resolveSource(value); return source ? `${source.ats}:${source.token.toLocaleLowerCase()}` : undefined; }
function issue(entry: FeedEntry, reason: string, detail: string): DiscoveryIssue { return { sourceUrl: entry.sourceUrl, reference: entry.reference, reason, detail }; }
function domainMatchesName(domain: string, name: string): boolean { const label = normalize(domain.replace(/^www\./, "").split(".")[0] ?? ""); const company = normalize(name); return label.length >= 3 && (label.includes(company) || company.includes(label)); }
function normalize(value: string): string { return value.toLocaleLowerCase().replace(/\b(inc|llc|ltd|limited|corp|corporation|company)\b/g, "").replace(/[^a-z0-9]/g, ""); }
function majority(values: string[]): string { const counts = new Map<string, number>(); for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1); return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ""; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
