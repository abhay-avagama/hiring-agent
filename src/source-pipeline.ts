import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { atomicJson } from "./atomic-file.ts";
import { withFileLock } from "./file-lock.ts";
import { resolveSource, verifyCandidates } from "./source-verification.ts";
import { deriveLeadState, mergeEnrichmentLeads, readEnrichmentRegistry, retryDisposition, strongestEvidenceRank, transientAttempt, type EnrichmentLead, type IdentityEvidence, type LeadAttempt } from "./enrichment-registry.ts";
import type { RejectedSource, SourceCandidate, VerifiedCompany } from "./types.ts";
import type { Ats } from "./types.ts";

interface PipelineOptions {
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  concurrency?: number;
  timeoutMs?: number;
  requireCountry?: string;
  countryGateTimeoutMs?: number;
  registryPath?: string;
  retryDeferred?: boolean;
  limit?: number;
  providerConcurrency?: Partial<Record<Ats, number>>;
  batchStatePath?: string;
}

export interface SourcePipelineReport {
  candidates: number;
  newCandidates: number;
  selected: number;
  selectedNew: number;
  deferred: number;
  verified: number;
  rejected: number;
  retryableFailures: number;
  preserved: number;
  carriedForward: number;
  batchStatePath: string;
  catalogPath: string;
  rejections: RejectedSource[];
}

export async function runSourceVerification(candidatesPath: string, catalogPath: string, options: PipelineOptions = {}): Promise<SourcePipelineReport> {
  await mkdir(dirname(catalogPath), { recursive: true });
  const batchStatePath = options.batchStatePath ?? `${catalogPath}.verification-state.json`;
  if (resolve(batchStatePath) === resolve(catalogPath)) throw new Error("Source verification batch state must not overwrite the catalog");
  return withFileLock(batchStatePath,
    () => withFileLock(catalogPath, () => runSourceVerificationUnlocked(candidatesPath, catalogPath, { ...options, batchStatePath }), { operation: "verify sources" }),
    { operation: "schedule source verification batch" });
}

async function runSourceVerificationUnlocked(candidatesPath: string, catalogPath: string, options: PipelineOptions): Promise<SourcePipelineReport> {
  const candidates = await readCandidates(candidatesPath);
  const prior = await readPriorCatalog(catalogPath);
  const batchStatePath = options.batchStatePath ?? `${catalogPath}.verification-state.json`;
  const batchState = await readBatchState(batchStatePath);
  const newCandidates = candidates.filter((candidate) => !candidateInCatalog(candidate, prior)).length;
  let eligible = candidates;
  const deferred: RejectedSource[] = [];
  if (options.registryPath) {
    const registry = await readEnrichmentRegistry(options.registryPath);
    const byKey = new Map(registry.leads.map((lead) => [lead.sourceKey, lead]));
    eligible = candidates.filter((candidate) => {
      const source = resolveSource(candidate.sourceUrl);
      const lead = source ? byKey.get(`${source.ats}:${source.token.toLowerCase()}`) : undefined;
      if (!lead) return true;
      const state = deriveLeadState(lead);
      const retry = retryDisposition(lead, options.now?.() ?? new Date());
      const providerCanAcquireIdentity = source?.ats === "recruitee" && state === "matched";
      if ((["evidence_ready", "verified"].includes(state) || providerCanAcquireIdentity) && (options.retryDeferred || !["cooling_down", "repeatedly_failing"].includes(retry))) return true;
      deferred.push({ ...candidate, reason: "unreachable", detail: `Verification deferred by enrichment policy (${state}, ${retry})` });
      return false;
    });
  }
  const limit = options.limit === undefined ? eligible.length : Math.max(1, Math.trunc(options.limit));
  const selected = [...eligible].sort((left, right) => compareVerificationPriority(left, right, prior, batchState)).slice(0, limit);
  const conflicts = selected.filter((candidate) => candidateConflictsCatalog(candidate, prior));
  const verifiable = selected.filter((candidate) => !candidateConflictsCatalog(candidate, prior));
  const result = await verifyCandidates(verifiable, options);
  result.rejected.unshift(...conflicts.map((candidate) => ({ ...candidate, reason: "duplicate_slug" as const, detail: `Catalog slug ${candidateSlug(candidate)} belongs to a different verified company` })));
  const retryableFailures = result.rejected.filter((candidate) => retryableRejection(candidate.reason)).length;
  const freshlyVerified = new Set(result.verified.map((company) => company.slug));
  const verifiedDomains = new Set(result.verified.map((company) => company.companyDomain));
  const verifiedSources = new Set(result.verified.map((company) => `${company.ats}:${company.token.toLocaleLowerCase()}`));
  const preserved = result.rejected.flatMap((candidate) => {
    if (!preservableRejection(candidate.reason)) return [];
    const slug = candidate.slug ?? slugFromDomain(candidate.companyDomain);
    if (freshlyVerified.has(slug)) return [];
    const previous = prior[slug];
    if (!previous || previous.companyDomain !== candidate.companyDomain.toLocaleLowerCase()) return [];
    if (verifiedDomains.has(previous.companyDomain) || verifiedSources.has(`${previous.ats}:${previous.token.toLocaleLowerCase()}`)) return [];
    return [{ slug, ...previous } as VerifiedCompany];
  });
  const selectedSlugs = new Set(verifiable.flatMap((candidate) => { const slug = candidateSlug(candidate); return slug ? [slug] : []; }));
  const untouched = Object.entries(prior).flatMap(([slug, company]) => selectedSlugs.has(slug) ? [] : [{ slug, ...company } as VerifiedCompany]);
  const attemptedAt = (options.now?.() ?? new Date()).toISOString();
  for (const candidate of selected) batchState.attempts[sourceKeyForCandidate(candidate)] = attemptedAt;
  batchState.updatedAt = attemptedAt;
  await atomicJson(batchStatePath, batchState);
  await writeCatalog(catalogPath, [...result.verified, ...preserved, ...untouched]);
  if (options.registryPath) await recordRegistryOutcomes(options.registryPath, result, options.now?.() ?? new Date());
  return {
    candidates: candidates.length,
    newCandidates,
    selected: selected.length,
    selectedNew: selected.filter((candidate) => !candidateInCatalog(candidate, prior)).length,
    deferred: deferred.length + Math.max(0, eligible.length - selected.length),
    verified: result.verified.length,
    rejected: result.rejected.length,
    retryableFailures,
    preserved: preserved.length,
    carriedForward: untouched.length,
    batchStatePath,
    catalogPath,
    rejections: result.rejected,
  };
}

function candidateInCatalog(candidate: SourceCandidate, catalog: Record<string, Omit<VerifiedCompany, "slug">>): boolean {
  if (typeof candidate.companyDomain !== "string" || typeof candidate.sourceUrl !== "string") return false;
  const slug = candidateSlug(candidate);
  if (!slug) return false;
  const previous = catalog[slug];
  return previous?.companyDomain === candidate.companyDomain.toLowerCase() && previous.sourceUrl === resolveSource(candidate.sourceUrl)?.canonicalSourceUrl;
}

interface VerificationBatchState { version: 1; updatedAt: string; attempts: Record<string, string> }

function compareVerificationPriority(left: SourceCandidate, right: SourceCandidate, catalog: Record<string, Omit<VerifiedCompany, "slug">>, state: VerificationBatchState): number {
  const leftAttempt = attemptTime(left, state);
  const rightAttempt = attemptTime(right, state);
  if (leftAttempt !== rightAttempt) return leftAttempt - rightAttempt;
  const leftKnown = candidateInCatalog(left, catalog);
  const rightKnown = candidateInCatalog(right, catalog);
  if (leftKnown !== rightKnown) return Number(leftKnown) - Number(rightKnown);
  if (!leftKnown) return 0;
  return verificationTime(left, catalog) - verificationTime(right, catalog);
}

function attemptTime(candidate: SourceCandidate, state: VerificationBatchState): number {
  const value = Date.parse(state.attempts[sourceKeyForCandidate(candidate)] ?? "");
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function verificationTime(candidate: SourceCandidate, catalog: Record<string, Omit<VerifiedCompany, "slug">>): number {
  const slug = candidateSlug(candidate);
  const value = slug ? Date.parse(catalog[slug]?.verification.checkedAt ?? "") : Number.NaN;
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function candidateConflictsCatalog(candidate: SourceCandidate, catalog: Record<string, Omit<VerifiedCompany, "slug">>): boolean {
  if (typeof candidate.companyDomain !== "string" || typeof candidate.sourceUrl !== "string") return false;
  const slug = candidateSlug(candidate);
  if (!slug || !catalog[slug]) return false;
  return !candidateInCatalog(candidate, catalog);
}

function candidateSlug(candidate: SourceCandidate): string | undefined {
  if (typeof candidate.slug === "string" && candidate.slug) return candidate.slug;
  return typeof candidate.companyDomain === "string" && candidate.companyDomain ? slugFromDomain(candidate.companyDomain) : undefined;
}

function sourceKeyForCandidate(candidate: SourceCandidate): string {
  if (typeof candidate.sourceUrl === "string") {
    const source = resolveSource(candidate.sourceUrl);
    if (source) return `${source.ats}:${source.token.toLowerCase()}`;
  }
  return `candidate:${String(candidate.companyDomain ?? "").toLowerCase()}|${String(candidate.sourceUrl ?? "")}`;
}

async function readBatchState(path: string): Promise<VerificationBatchState> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value) && (value as { version?: unknown }).version === 1 && typeof (value as { attempts?: unknown }).attempts === "object" && (value as { attempts?: unknown }).attempts !== null && !Array.isArray((value as { attempts?: unknown }).attempts)) {
      const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
      const entries = Object.entries((value as { attempts: Record<string, unknown> }).attempts);
      if (typeof updatedAt === "string" && Number.isFinite(Date.parse(updatedAt)) && entries.every((entry): entry is [string, string] => entry[0].length > 0 && typeof entry[1] === "string" && Number.isFinite(Date.parse(entry[1])))) {
        return { version: 1, updatedAt, attempts: Object.fromEntries(entries) };
      }
    }
    throw new Error(`Invalid source verification batch state: ${path}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { version: 1, updatedAt: new Date(0).toISOString(), attempts: {} };
    if (error instanceof SyntaxError) throw new Error(`Invalid source verification batch state JSON: ${path}`);
    throw error;
  }
}

async function recordRegistryOutcomes(registryPath: string, result: Awaited<ReturnType<typeof verifyCandidates>>, now: Date): Promise<void> {
  const registry = await readEnrichmentRegistry(registryPath);
  const byKey = new Map(registry.leads.map((lead) => [lead.sourceKey, lead]));
  const additions: EnrichmentLead[] = [];
  for (const company of result.verified) {
    const lead = byKey.get(`${company.ats}:${company.token.toLowerCase()}`);
    if (!lead) continue;
    const attempt: LeadAttempt = { attemptedAt: now.toISOString(), outcome: "success" };
    const evidence: IdentityEvidence[] = company.verification.identityEvidence === "structured_domain_link"
      ? [{ companyName: company.name, companyDomain: company.companyDomain, kind: "provider_structured_domain", reference: company.sourceUrl, observedAt: now.toISOString() }]
      : company.verification.identityEvidence === "company_redirect" && company.domainEvidence?.kind === "company_redirect"
        ? [{ companyName: company.name, companyDomain: company.companyDomain, kind: "company_redirect", reference: company.domainEvidence.reference, observedAt: now.toISOString() }]
        : [];
    additions.push({ ...lead, identityEvidence: evidence, attempts: [attempt], promotedAt: now.toISOString() });
  }
  for (const rejection of result.rejected) {
    if (rejection.detail.startsWith("Verification deferred by enrichment policy")) continue;
    const source = resolveSource(rejection.sourceUrl);
    if (!source) continue;
    const lead = byKey.get(`${source.ats}:${source.token.toLowerCase()}`);
    if (!lead) continue;
    const transient = retryableRejection(rejection.reason);
    const consecutive = [...lead.attempts].reverse().findIndex((attempt) => attempt.outcome !== "transient_failure");
    const attempt: LeadAttempt = transient
      ? transientAttempt(now, consecutive < 0 ? lead.attempts.length + 1 : consecutive + 1, rejection.reason, rejection.detail)
      : { attemptedAt: now.toISOString(), outcome: "permanent_failure", category: rejection.reason, detail: rejection.detail, evidenceRank: strongestEvidenceRank(lead) };
    additions.push({ ...lead, attempts: [attempt] });
  }
  if (additions.length) await mergeEnrichmentLeads(registryPath, additions, now);
}

function preservableRejection(reason: RejectedSource["reason"]): boolean { return ["unreachable", "invalid_payload", "empty_board", "no_country_jobs"].includes(reason); }
function retryableRejection(reason: RejectedSource["reason"]): boolean { return reason === "unreachable"; }

async function readPriorCatalog(path: string): Promise<Record<string, Omit<VerifiedCompany, "slug">>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, Omit<VerifiedCompany, "slug">> : {};
  } catch { return {}; }
}

async function readCandidates(path: string): Promise<SourceCandidate[]> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error(`Cannot read candidate file ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(value) || !value.every((candidate) => typeof candidate === "object" && candidate !== null && !Array.isArray(candidate))) {
    throw new Error("Candidate file must contain a JSON array of objects");
  }
  return value as SourceCandidate[];
}

async function writeCatalog(path: string, companies: VerifiedCompany[]): Promise<void> {
  const catalog = Object.fromEntries(companies.sort((a, b) => a.slug.localeCompare(b.slug)).map(({ slug, ...company }) => [slug, company]));
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`);
  await rename(temporary, path);
}

function slugFromDomain(domain: string): string { return domain.toLocaleLowerCase().replace(/^www\./, "").split(".")[0]!.replace(/[^a-z0-9-]/g, "-"); }
