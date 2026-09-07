import { atomicJson } from "./atomic-file.ts";
import { readEnrichmentRegistry, mergeEnrichmentLeads, type EnrichmentLead, type LeadAttempt } from "./enrichment-registry.ts";
import { withFileLock } from "./file-lock.ts";
import { providerSpec } from "./providers.ts";
import { resolveSource } from "./source-verification.ts";
import type { Ats, Company, SourceVerification } from "./types.ts";

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Providers whose public board is accepted as identity on its own. Workday boards are identified by tenant; their crawls are heavier but they carry the large employers. */
export const BOARD_TIER_PROVIDERS: ReadonlySet<Ats> = new Set(["greenhouse", "lever", "ashby", "recruitee", "smartrecruiters", "workable", "breezy", "workday", "freshteam"]);

export interface BoardVerificationOptions {
  fetch?: Fetch;
  now?: () => Date;
  limit?: number;
  concurrency?: number;
  timeoutMs?: number;
  /** Days before a board that permanently failed is probed again. */
  cooldownDays?: number;
}

export interface BoardVerificationReport {
  generatedAt: string;
  considered: number;
  selected: number;
  skipped: { inCatalog: number; coolingDown: number; unsupported: number; deferred: number };
  verified: number;
  added: string[];
  rejected: Array<{ sourceKey: string; reason: "unreachable" | "invalid_payload" | "empty_board" | "duplicate_slug"; detail: string }>;
  catalogSize: number;
}

type CatalogEntry = Omit<Company, "slug"> & { verification: SourceVerification };

/**
 * Board-verified tier: a public ATS board is admitted on the provider's own identity (board name or tenant) without proof of
 * the company website. Entries carry `identityEvidence: "provider_board"` and no `companyDomain`, so every consumer can tell
 * them apart from company-verified sources.
 */
export async function verifyBoards(registryPath: string, catalogPath: string, options: BoardVerificationOptions = {}): Promise<BoardVerificationReport> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const limit = Math.max(1, Math.trunc(options.limit ?? 200));
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 8));
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 30_000));
  const cooldownMs = Math.max(0, options.cooldownDays ?? 30) * 86_400_000;

  return withFileLock(catalogPath, async () => {
    const catalog = await readCatalog(catalogPath);
    const registry = await readEnrichmentRegistry(registryPath);
    const knownSources = new Set(Object.values(catalog).map((entry) => `${entry.ats}:${entry.token.toLowerCase()}`));
    const skipped = { inCatalog: 0, coolingDown: 0, unsupported: 0, deferred: 0 };
    const eligible: EnrichmentLead[] = [];
    for (const lead of registry.leads) {
      if (!BOARD_TIER_PROVIDERS.has(lead.ats) || !resolveSource(lead.sourceUrl)) { skipped.unsupported += 1; continue; }
      if (knownSources.has(`${lead.ats}:${lead.token.toLowerCase()}`)) { skipped.inCatalog += 1; continue; }
      if (looksLikeTestBoard(lead.token)) { skipped.unsupported += 1; continue; }
      if (coolingDown(lead, now(), cooldownMs)) { skipped.coolingDown += 1; continue; }
      eligible.push(lead);
    }
    const selected = eligible.slice(0, limit);
    skipped.deferred = eligible.length - selected.length;

    const usedSlugs = new Set(Object.keys(catalog));
    const added: string[] = [];
    const rejected: BoardVerificationReport["rejected"] = [];
    const updatedLeads: EnrichmentLead[] = [];
    let cursor = 0;
    async function worker() {
      while (cursor < selected.length) {
        const lead = selected[cursor++]!;
        const attemptedAt = now().toISOString();
        try {
          const probe = await probeBoard(lead, fetcher, timeoutMs);
          const name = probe.providerName || lead.companyMatches[0]?.companyName || humanize(lead.token);
          const source = resolveSource(lead.sourceUrl)!;
          const slug = uniqueSlug(lead, usedSlugs);
          if (!slug) {
            rejected.push({ sourceKey: lead.sourceKey, reason: "duplicate_slug", detail: `Catalog slug already used for ${lead.token}` });
            updatedLeads.push(withAttempt(lead, { attemptedAt, outcome: "permanent_failure", category: "duplicate_slug", detail: "slug collision" }));
            continue;
          }
          usedSlugs.add(slug);
          catalog[slug] = {
            name, ats: lead.ats, token: source.token, sourceUrl: source.canonicalSourceUrl,
            discoveredFrom: lead.discoveredFrom[0] ?? { channel: "dataset", reference: registryPath },
            verification: { observedCompanyName: name, identityEvidence: "provider_board", contentType: probe.contentType, payloadVersion: probe.payloadVersion, jobCount: probe.jobCount, checkedAt: attemptedAt, canonicalSourceUrl: source.canonicalSourceUrl },
          };
          added.push(slug);
          updatedLeads.push({ ...withAttempt(lead, { attemptedAt, outcome: "success", category: "provider_board", detail: `${probe.jobCount} jobs` }), promotedAt: attemptedAt });
        } catch (error) {
          const reason = error instanceof BoardError ? error.reason : "unreachable";
          const detail = error instanceof Error ? error.message : String(error);
          const outcome = error instanceof BoardError && error.reason !== "unreachable" ? "permanent_failure" : "transient_failure";
          rejected.push({ sourceKey: lead.sourceKey, reason, detail });
          updatedLeads.push(withAttempt(lead, { attemptedAt, outcome, category: reason, detail }));
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, worker));

    if (added.length) await atomicJson(catalogPath, Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b))));
    if (updatedLeads.length) await mergeEnrichmentLeads(registryPath, updatedLeads, now());
    return {
      generatedAt: now().toISOString(), considered: registry.leads.length, selected: selected.length, skipped,
      verified: added.length, added: added.sort(), rejected: rejected.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)), catalogSize: Object.keys(catalog).length,
    };
  }, { operation: "verify boards" });
}

/** Random-looking tokens are almost always someone's test board: a long digit run mixed with letters, or a long consonant string. Short brand tokens like 2k or bvnk pass. */
export function looksLikeTestBoard(token: string): boolean {
  const value = token.toLowerCase();
  return /[a-z]/.test(value) && (/\d{5,}/.test(value) || (value.length >= 8 && !/[aeiouy]/.test(value)));
}

class BoardError extends Error {
  constructor(readonly reason: "unreachable" | "invalid_payload" | "empty_board", message: string) { super(message); }
}

async function probeBoard(lead: EnrichmentLead, fetcher: Fetch, timeoutMs: number): Promise<{ providerName: string; contentType: string; payloadVersion: string; jobCount: number }> {
  const source = resolveSource(lead.sourceUrl)!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const init: RequestInit = source.ats === "workday"
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: "" }), signal: controller.signal }
      : { signal: controller.signal };
    const response = await fetcher(source.structuredEndpoint, init);
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new BoardError(response.status === 404 || response.status === 410 ? "invalid_payload" : "unreachable", `HTTP ${response.status}`); }
    let body: unknown;
    try { body = await response.json(); } catch { throw new BoardError("invalid_payload", "Endpoint did not return JSON"); }
    const spec = providerSpec(source.ats);
    const jobs = spec ? spec.jobsFromBody(body) : source.ats === "lever" ? asArray(body) : asArray(isRecord(body) ? body[source.ats === "recruitee" ? "offers" : source.ats === "workday" ? "jobPostings" : "jobs"] : undefined);
    if (!jobs) throw new BoardError("invalid_payload", "Payload does not contain the expected jobs array");
    if (jobs.length === 0) throw new BoardError("empty_board", "Board has no jobs");
    const providerName = spec ? spec.providerName(jobs, body) : source.ats === "greenhouse" ? majority(jobs.map((job) => typeof job.company_name === "string" ? job.company_name.trim() : "").filter(Boolean)) : source.ats === "workday" ? humanize(source.token.split("/")[1] ?? source.token) : "";
    const payloadVersion = spec ? spec.payloadVersion(body) : source.ats === "greenhouse" ? "greenhouse-job-board:v1" : source.ats === "lever" ? "lever-postings:v0" : source.ats === "recruitee" ? "recruitee-careers:v1" : source.ats === "workday" ? "workday-cxs:v1" : `ashby-job-board:${isRecord(body) && typeof body.apiVersion === "string" ? body.apiVersion : "unknown"}`;
    const jobCount = source.ats === "workday" && isRecord(body) && typeof body.total === "number" ? body.total : jobs.length;
    return { providerName, contentType: response.headers.get("content-type") ?? "unknown", payloadVersion, jobCount };
  } finally { clearTimeout(timer); }
}

function coolingDown(lead: EnrichmentLead, now: Date, cooldownMs: number): boolean {
  const last = lead.attempts[lead.attempts.length - 1];
  if (!last) return false;
  const age = now.getTime() - Date.parse(last.attemptedAt);
  if (last.outcome === "permanent_failure") return age < cooldownMs;
  if (last.outcome === "transient_failure") return age < 86_400_000;
  return false;
}

function withAttempt(lead: EnrichmentLead, attempt: LeadAttempt): EnrichmentLead {
  return { ...lead, attempts: [...lead.attempts, attempt] };
}

function uniqueSlug(lead: EnrichmentLead, used: Set<string>): string | null {
  const raw = lead.ats === "workday" ? (lead.token.split("/")[1] ?? lead.token) : lead.token;
  const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || lead.ats;
  for (const candidate of [base, `${lead.ats}-${base}`]) if (!used.has(candidate)) return candidate;
  return null;
}

/** "acme-corp" -> "Acme Corp". Used only when the provider exposes no company name. */
export function humanize(token: string): string {
  return token.split(/[-_.]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

async function readCatalog(path: string): Promise<Record<string, CatalogEntry>> {
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as unknown;
    if (!isRecord(parsed)) throw new Error(`Catalog is not an object: ${path}`);
    return parsed as Record<string, CatalogEntry>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

function majority(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}
function asArray(value: unknown): Record<string, unknown>[] | null { return Array.isArray(value) && value.every(isRecord) ? value : null; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
