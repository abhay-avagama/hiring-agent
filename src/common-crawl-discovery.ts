import { readFile } from "node:fs/promises";
import { atomicJson } from "./atomic-file.ts";
import { stampReport, type ReportMeta } from "./report-meta.ts";
import { mergeEnrichmentLeads, type EnrichmentLead } from "./enrichment-registry.ts";
import { PROVIDERS } from "./providers.ts";
import { resolveSource } from "./source-verification.ts";
import type { Ats } from "./types.ts";
import { assertArtifactFile } from "./artifact-path.ts";

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
interface Options { country?: string; fetch?: Fetch; indexUrl?: string; registryPath?: string; provider?: Ats; indexRecordLimit?: number; sampleTokenLimit?: number; excludeTokens?: string[] }
interface Lead { sourceUrl: string; ats: string; token: string; discoveredFrom: { channel: "dataset"; reference: string } }
interface Collection { id?: unknown; "cdx-api"?: unknown }

export interface CommonCrawlDiscoveryReport extends ReportMeta {
  country?: string;
  provider?: Ats;
  index: string;
  indexRecordsExamined: number;
  sampleTokenLimit?: number;
  sampleShortfall: number;
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
  availableLeads: Lead[];
  leads: Lead[];
  rejections: Array<{ value: string; reason: string }>;
}

const providerPatterns: Record<Ats, string[]> = {
  greenhouse: ["job-boards.greenhouse.io/*", "boards.greenhouse.io/*"], lever: ["jobs.lever.co/*"], ashby: ["jobs.ashbyhq.com/*"], workday: ["*.myworkdayjobs.com/*"], recruitee: ["*.recruitee.com/*"],
  ...Object.fromEntries(PROVIDERS.map((spec) => [spec.ats, spec.crawlPatterns])) as Record<"smartrecruiters" | "workable" | "breezy" | "freshteam", string[]>,
};
const patterns = Object.values(providerPatterns).flat();
const recordsPerPattern = 10_000;

export async function discoverCommonCrawlSources(candidatesPath: string, reportPath: string, options: Options = {}): Promise<CommonCrawlDiscoveryReport> {
  if (options.provider === "recruitee") await assertArtifactFile(reportPath);
  const country = options.country?.toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw new Error("country must be a two-letter code");
  const indexRecordLimit = options.indexRecordLimit ?? recordsPerPattern;
  if (!Number.isInteger(indexRecordLimit) || indexRecordLimit < 1 || indexRecordLimit > recordsPerPattern) throw new Error(`indexRecordLimit must be an integer from 1 to ${recordsPerPattern}`);
  const sampleTokenLimit = options.sampleTokenLimit;
  if (sampleTokenLimit !== undefined && (!Number.isInteger(sampleTokenLimit) || sampleTokenLimit < 1 || sampleTokenLimit > indexRecordLimit)) throw new Error("sampleTokenLimit must be a positive integer no greater than indexRecordLimit");
  if (options.provider === "recruitee" && (indexRecordLimit > 2_000 || sampleTokenLimit === undefined || sampleTokenLimit > 60 || options.registryPath)) throw new Error("Bounded Recruitee discovery requires at most 2,000 records, at most 60 sampled tokens, and report-only output");
  const fetcher = options.fetch ?? globalThis.fetch;
  const index = options.indexUrl ?? await latestIndex(fetcher);
  const existing = await readExistingKeys(candidatesPath);
  const found = new Map<string, ReturnType<typeof resolveSource>>();
  const seenUrls = new Set<string>();
  const rejections: Array<{ value: string; reason: string }> = [];
  const truncatedPatterns: string[] = [];
  let indexRecordsExamined = 0;

  for (const pattern of options.provider ? providerPatterns[options.provider] : patterns) {
    const query = new URL(index);
    query.searchParams.set("url", pattern);
    query.searchParams.set("output", "json");
    query.searchParams.set("filter", "status:200");
    query.searchParams.set("collapse", "urlkey");
    query.searchParams.set("fl", "url");
    query.searchParams.set("limit", String(indexRecordLimit));
    const response = await fetcher(query);
    if (!response.ok) throw new Error(`Common Crawl index returned HTTP ${response.status} for ${pattern}`);
    const lines = (await response.text()).split(/\r?\n/).filter(Boolean).slice(0, indexRecordLimit);
    indexRecordsExamined += lines.length;
    if (lines.length >= indexRecordLimit) truncatedPatterns.push(pattern);
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

  const availableLeads: Lead[] = [];
  const excludedTokens = new Set((options.excludeTokens ?? []).map((token) => token.toLowerCase()));
  let alreadyKnown = 0;
  for (const [key, source] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
    if (!source) continue;
    if (existing.has(key)) { alreadyKnown++; continue; }
    if (excludedTokens.has(source.token.toLowerCase())) continue;
    availableLeads.push({
      sourceUrl: source.canonicalSourceUrl, ats: source.ats, token: source.token,
      discoveredFrom: { channel: "dataset", reference: index },
    });
  }
  const leads = sampleTokenLimit === undefined ? availableLeads : availableLeads.slice(0, sampleTokenLimit);
  const registryLeads: EnrichmentLead[] = leads.map((lead) => ({
      sourceKey: `${lead.ats}:${lead.token.toLowerCase()}`, sourceUrl: lead.sourceUrl, ats: lead.ats as Ats, token: lead.token,
      discoveredFrom: [lead.discoveredFrom], companyMatches: [], identityEvidence: [], attempts: [],
    }));
  const registry = options.registryPath ? await mergeEnrichmentLeads(options.registryPath, registryLeads) : { added: 0, bytes: undefined, lockHeldMs: undefined };
  const report: CommonCrawlDiscoveryReport = stampReport("common-crawl-discovery:1", 1, {
    country, provider: options.provider, index, indexRecordsExamined, sampleTokenLimit, sampleShortfall: sampleTokenLimit === undefined ? 0 : Math.max(0, sampleTokenLimit - leads.length), urlsSeen: seenUrls.size, sourcesFound: found.size, alreadyKnown, unresolved: leads.length, rejected: rejections.length,
    truncated: truncatedPatterns.length > 0, truncatedPatterns,
    candidatesPath, reportPath, registryPath: options.registryPath, registryAdded: registry.added, registryBytes: registry.bytes, registryLockHeldMs: registry.lockHeldMs, availableLeads, leads, rejections,
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
