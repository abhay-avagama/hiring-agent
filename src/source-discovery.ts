import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicJson } from "./atomic-file.ts";
import { stampReport, type ReportMeta } from "./report-meta.ts";
import { withFileLock } from "./file-lock.ts";
import { resolveSource } from "./source-verification.ts";
import type { DiscoveryChannel, SourceCandidate } from "./types.ts";
import { mergeEnrichmentLeads, type EnrichmentLead, type IdentityEvidence } from "./enrichment-registry.ts";

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface DiscoveryOptions {
  country?: string;
  fetch?: Fetch;
  concurrency?: number;
  timeoutMs?: number;
  registryPath?: string;
}

interface FeedEntry { sourceUrl: string; companyName?: string; companyDomain?: string; reference?: string; channel?: DiscoveryChannel; domainEvidence?: "authoritative_dataset" | "company_registry" | "company_redirect" }
interface DiscoveryIssue { sourceUrl: string; reason: string; detail: string; companyName?: string; reference?: string }

export interface SourceDiscoveryReport extends ReportMeta {
  discovered: number;
  ready: number;
  alreadyKnown: number;
  needsDomain: number;
  rejected: number;
  candidatesPath: string;
  reportPath: string;
  unresolved: DiscoveryIssue[];
  rejections: DiscoveryIssue[];
  registryPath?: string;
  registryAdded: number;
}

export async function runSourceDiscovery(feedPath: string, candidatesPath: string, reportPath: string, options: DiscoveryOptions = {}): Promise<SourceDiscoveryReport> {
  const feed = await readFeed(feedPath);
  return discoverEntries(feed, candidatesPath, reportPath, options, feedPath, false);
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
      companyName: typeof company.name === "string" ? company.name : company.slug,
      companyDomain,
      reference: `https://www.ycombinator.com/companies/${company.slug}`,
      domainEvidence: "authoritative_dataset",
    }];
  });
  return discoverEntries(feed, candidatesPath, reportPath, { ...options, fetch: fetcher, country }, "YC public company API", true);
}

async function discoverEntries(feed: FeedEntry[], candidatesPath: string, reportPath: string, options: DiscoveryOptions, feedReference: string, trustDomainEvidence: boolean): Promise<SourceDiscoveryReport> {
  const existing = await readCandidates(candidatesPath);
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 10));
  const country = options.country?.toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw new Error("country must be a two-letter code");
  const ready: Array<{ index: number; candidate: SourceCandidate }> = [];
  const unresolved: Array<{ index: number; issue: DiscoveryIssue }> = [];
  const rejected: Array<{ index: number; issue: DiscoveryIssue }> = [];
  const registryRows: EnrichmentLead[] = [];
  const existingSources = new Set(existing.map((candidate) => sourceKey(candidate.sourceUrl)).filter(Boolean));
  let alreadyKnown = 0;
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
      if (entry.companyName !== undefined && (typeof entry.companyName !== "string" || !entry.companyName.trim())) {
        rejected.push({ index, issue: issue({ sourceUrl: entry.sourceUrl }, "invalid_name", "companyName must be a non-empty string") });
        continue;
      }
      if (entry.reference !== undefined && typeof entry.reference !== "string") {
        rejected.push({ index, issue: issue({ sourceUrl: entry.sourceUrl }, "invalid_reference", "reference must be a string") });
        continue;
      }
      const source = resolveSource(entry.sourceUrl);
      if (!source) {
        rejected.push({ index, issue: issue(entry, "unsupported_source", "Discovery accepts Greenhouse, Lever, Ashby, Workday, and Recruitee source URLs") });
        continue;
      }
      if (entry.channel !== undefined && !["search", "career_page", "provider_directory", "community", "dataset"].includes(entry.channel)) {
        rejected.push({ index, issue: issue(entry, "invalid_channel", `Unsupported discovery channel: ${entry.channel}`) });
        continue;
      }
      if (entry.domainEvidence !== undefined && !["authoritative_dataset", "company_registry", "company_redirect"].includes(entry.domainEvidence)) {
        rejected.push({ index, issue: issue(entry, "invalid_domain_evidence", `Unsupported domain evidence: ${entry.domainEvidence}`) });
        continue;
      }
      const key = `${source.ats}:${source.token.toLocaleLowerCase()}`;
      const companyName = typeof entry.companyName === "string" ? entry.companyName.trim() : "";
      const reference = entry.reference?.trim() || feedReference;
      const match = entry.companyDomain && companyName ? [{ companyName, companyDomain: entry.companyDomain.toLowerCase(), method: "normalized_token" as const, reference }] : [];
      const redirectTrusted = entry.domainEvidence === "company_redirect" && entry.companyDomain && referenceBelongsToDomain(reference, entry.companyDomain);
      const datasetTrusted = trustDomainEvidence && entry.domainEvidence && entry.domainEvidence !== "company_redirect";
      const evidence: IdentityEvidence[] = (redirectTrusted || datasetTrusted) && entry.companyDomain && companyName ? [{ companyName, companyDomain: entry.companyDomain.toLowerCase(), kind: entry.domainEvidence!, reference, observedAt: new Date().toISOString() }] : [];
      registryRows.push({ sourceKey: key, sourceUrl: source.canonicalSourceUrl, ats: source.ats, token: source.token,
        discoveredFrom: [{ channel: entry.channel ?? "dataset", reference }], companyMatches: match, identityEvidence: evidence, attempts: [] });
      if (existingSources.has(key)) {
        alreadyKnown++;
        continue;
      }
      if (!entry.companyDomain || !companyName) {
        unresolved.push({ index, issue: { ...issue(entry, "needs_identity", "companyName and companyDomain are required before verification"), companyName: companyName || undefined } });
        continue;
      }
      const providerCanAcquireIdentity = source.ats === "recruitee";
      if (!redirectTrusted && !datasetTrusted && !providerCanAcquireIdentity) {
        unresolved.push({ index, issue: { ...issue(entry, "needs_domain_evidence", "The entry needs trusted dataset evidence or a company-owned redirect"), companyName } });
        continue;
      }
      ready.push({ index, candidate: {
        companyName, companyDomain: entry.companyDomain.toLocaleLowerCase(), sourceUrl: source.canonicalSourceUrl,
        cohorts: country ? [country] : undefined,
        discoveredFrom: { channel: entry.channel ?? "dataset", reference },
        ...((redirectTrusted || datasetTrusted) ? { domainEvidence: { kind: entry.domainEvidence!, reference } } : {}),
      } });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, feed.length) }, worker));
  const registry = options.registryPath ? await mergeEnrichmentLeads(options.registryPath, registryRows) : { added: 0 };
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
  const unresolvedSources = new Set<string>();
  const uniqueUnresolved = filteredUnresolved.filter((row) => {
    const key = sourceKey(row.issue.sourceUrl);
    if (!key || !unresolvedSources.has(key)) { if (key) unresolvedSources.add(key); return true; }
    rejected.push({ index: row.index, issue: { ...row.issue, reason: "duplicate_source", detail: `Duplicate of ${key}` } });
    return false;
  });
  const appended = await mergeSourceCandidates(candidatesPath, additions);
  const report: SourceDiscoveryReport = stampReport("source-discovery:1", 1, {
    discovered: feed.length, ready: appended, alreadyKnown, needsDomain: uniqueUnresolved.length, rejected: rejected.length,
    candidatesPath, reportPath, registryPath: options.registryPath, registryAdded: registry.added,
    unresolved: uniqueUnresolved.sort((a, b) => a.index - b.index).map((row) => row.issue),
    rejections: rejected.sort((a, b) => a.index - b.index).map((row) => row.issue),
  });
  await atomicJson(reportPath, report);
  return report;
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

export async function mergeSourceCandidates(path: string, additions: SourceCandidate[]): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  return withFileLock(path, async () => {
    const current = await readCandidates(path);
    const positions = new Map(current.flatMap((candidate, index) => {
      const key = sourceKey(candidate.sourceUrl);
      return key ? [[key, index] as const] : [];
    }));
    const seen = new Set(positions.keys());
    const unique = additions.filter((candidate) => {
      const key = sourceKey(candidate.sourceUrl);
      if (!key) return false;
      const existingIndex = positions.get(key);
      if (existingIndex !== undefined) {
        const existing = current[existingIndex]!;
        const cohorts = [...new Set([...(existing.cohorts ?? []), ...(candidate.cohorts ?? [])])].sort();
        current[existingIndex] = {
          ...existing,
          ...(cohorts.length ? { cohorts } : {}),
          ...(candidate.domainEvidence && !existing.domainEvidence ? { domainEvidence: candidate.domainEvidence, discoveredFrom: candidate.discoveredFrom } : {}),
        };
        return false;
      }
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    await atomicJson(path, [...current, ...unique]);
    return unique.length;
  }, { operation: "merge source candidates" });
}


function sourceKey(value: string): string | undefined { const source = resolveSource(value); return source ? `${source.ats}:${source.token.toLocaleLowerCase()}` : undefined; }
function issue(entry: FeedEntry, reason: string, detail: string): DiscoveryIssue { return { sourceUrl: entry.sourceUrl, reference: entry.reference, reason, detail }; }
function referenceBelongsToDomain(reference: string, domain: string): boolean { try { const host = new URL(reference).hostname.toLowerCase().replace(/^www\./, ""); const expected = domain.toLowerCase().replace(/^www\./, ""); return host === expected || host.endsWith(`.${expected}`); } catch { return false; } }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
