import { readFile } from "node:fs/promises";
import { atomicJson } from "./atomic-file.ts";
import { stampReport, type ReportMeta } from "./report-meta.ts";
import { mergeEnrichmentLeads, type EnrichmentLead } from "./enrichment-registry.ts";
import { resolveSource } from "./source-verification.ts";

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
interface Options { country?: string; fetch?: Fetch; indexUrl?: string; registryPath?: string }
interface Lead { sourceUrl: string; ats: string; token: string; discoveredFrom: { channel: "dataset"; reference: string } }
interface Collection { id?: unknown; "cdx-api"?: unknown }

export interface CommonCrawlDiscoveryReport extends ReportMeta {
  country?: string;
  index: string;
  urlsSeen: number;
  sourcesFound: number;
  alreadyKnown: number;
  unresolved: number;
  rejected: number;
  truncated: boolean;
  truncatedPatterns: string[];
  candidatesPath: string;
  reportPath: string;
  registryPath?: string;
  registryAdded: number;
  registryBytes?: number;
  registryLockHeldMs?: number;
  leads: Lead[];
  rejections: Array<{ value: string; reason: string }>;
}

const patterns = ["job-boards.greenhouse.io/*", "boards.greenhouse.io/*", "jobs.lever.co/*", "jobs.ashbyhq.com/*", "*.myworkdayjobs.com/*", "*.recruitee.com/*"];
const recordsPerPattern = 10_000;

export async function discoverCommonCrawlSources(candidatesPath: string, reportPath: string, options: Options = {}): Promise<CommonCrawlDiscoveryReport> {
  const country = options.country?.toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw new Error("country must be a two-letter code");
  const fetcher = options.fetch ?? globalThis.fetch;
  const index = options.indexUrl ?? await latestIndex(fetcher);
  const existing = await readExistingKeys(candidatesPath);
  const found = new Map<string, ReturnType<typeof resolveSource>>();
  const seenUrls = new Set<string>();
  const rejections: Array<{ value: string; reason: string }> = [];
  const truncatedPatterns: string[] = [];

  for (const pattern of patterns) {
    const query = new URL(index);
    query.searchParams.set("url", pattern);
    query.searchParams.set("output", "json");
    query.searchParams.set("filter", "status:200");
    query.searchParams.set("collapse", "urlkey");
    query.searchParams.set("fl", "url");
    query.searchParams.set("limit", String(recordsPerPattern));
    const response = await fetcher(query);
    if (!response.ok) throw new Error(`Common Crawl index returned HTTP ${response.status} for ${pattern}`);
    const lines = (await response.text()).split(/\r?\n/).filter(Boolean);
    if (lines.length >= recordsPerPattern) truncatedPatterns.push(pattern);
    for (const line of lines) {
      let value: unknown;
      try { value = JSON.parse(line); } catch { rejections.push({ value: line, reason: "invalid_index_record" }); continue; }
      if (!isRecord(value) || typeof value.url !== "string") { rejections.push({ value: line, reason: "missing_url" }); continue; }
      seenUrls.add(value.url);
      const source = resolveSource(value.url);
      if (!source) { rejections.push({ value: value.url, reason: "unsupported_source" }); continue; }
      found.set(`${source.ats}:${source.token.toLowerCase()}`, source);
    }
  }

  const leads: Lead[] = [];
  const registryLeads: EnrichmentLead[] = [];
  let alreadyKnown = 0;
  for (const [key, source] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
    if (!source) continue;
    if (existing.has(key)) { alreadyKnown++; continue; }
    leads.push({
      sourceUrl: source.canonicalSourceUrl, ats: source.ats, token: source.token,
      discoveredFrom: { channel: "dataset", reference: index },
    });
    registryLeads.push({ sourceKey: key, sourceUrl: source.canonicalSourceUrl, ats: source.ats, token: source.token,
      discoveredFrom: [{ channel: "dataset", reference: index }], companyMatches: [], identityEvidence: [], attempts: [] });
  }
  const registry = options.registryPath ? await mergeEnrichmentLeads(options.registryPath, registryLeads) : { added: 0, bytes: undefined, lockHeldMs: undefined };
  const report: CommonCrawlDiscoveryReport = stampReport("common-crawl-discovery:1", 1, {
    country, index, urlsSeen: seenUrls.size, sourcesFound: found.size, alreadyKnown, unresolved: leads.length, rejected: rejections.length,
    truncated: truncatedPatterns.length > 0, truncatedPatterns,
    candidatesPath, reportPath, registryPath: options.registryPath, registryAdded: registry.added, registryBytes: registry.bytes, registryLockHeldMs: registry.lockHeldMs, leads, rejections,
  });
  await atomicJson(reportPath, report);
  return report;
}

async function latestIndex(fetcher: Fetch): Promise<string> {
  const response = await fetcher("https://index.commoncrawl.org/collinfo.json");
  if (!response.ok) throw new Error(`Common Crawl collection list returned HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!Array.isArray(value)) throw new Error("Common Crawl collection list is invalid");
  const collection = value.find((entry): entry is Collection => isRecord(entry) && typeof entry["cdx-api"] === "string");
  if (!collection || typeof collection["cdx-api"] !== "string") throw new Error("Common Crawl collection list contains no queryable index");
  return collection["cdx-api"];
}

async function readExistingKeys(path: string): Promise<Set<string>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(value)) throw new Error("Candidate file must contain an array");
    return new Set(value.flatMap((candidate) => isRecord(candidate) && typeof candidate.sourceUrl === "string" ? [resolveSource(candidate.sourceUrl)] : [])
      .filter((source): source is NonNullable<ReturnType<typeof resolveSource>> => Boolean(source))
      .map((source) => `${source.ats}:${source.token.toLowerCase()}`));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Set();
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
