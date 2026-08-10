import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileLock } from "./file-lock.ts";
import { resolveSource, verifyCandidates } from "./source-verification.ts";
import { deriveLeadState, mergeEnrichmentLeads, readEnrichmentRegistry, retryDisposition, strongestEvidenceRank, transientAttempt, type EnrichmentLead, type IdentityEvidence, type LeadAttempt } from "./enrichment-registry.ts";
import type { RejectedSource, SourceCandidate, VerifiedCompany } from "./types.ts";

interface PipelineOptions {
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  concurrency?: number;
  timeoutMs?: number;
  requireCountry?: string;
  countryGateTimeoutMs?: number;
  registryPath?: string;
  retryDeferred?: boolean;
}

export interface SourcePipelineReport {
  candidates: number;
  verified: number;
  rejected: number;
  preserved: number;
  catalogPath: string;
  rejections: RejectedSource[];
}

export async function runSourceVerification(candidatesPath: string, catalogPath: string, options: PipelineOptions = {}): Promise<SourcePipelineReport> {
  await mkdir(dirname(catalogPath), { recursive: true });
  return withFileLock(catalogPath, () => runSourceVerificationUnlocked(candidatesPath, catalogPath, options), { operation: "verify sources" });
}

async function runSourceVerificationUnlocked(candidatesPath: string, catalogPath: string, options: PipelineOptions): Promise<SourcePipelineReport> {
  const candidates = await readCandidates(candidatesPath);
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
      if (["evidence_ready", "verified"].includes(state) && (options.retryDeferred || !["cooling_down", "repeatedly_failing"].includes(retry))) return true;
      deferred.push({ ...candidate, reason: "unreachable", detail: `Verification deferred by enrichment policy (${state}, ${retry})` });
      return false;
    });
  }
  const result = await verifyCandidates(eligible, options);
  result.rejected.push(...deferred);
  const prior = await readPriorCatalog(catalogPath);
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
  await writeCatalog(catalogPath, [...result.verified, ...preserved]);
  if (options.registryPath) await recordRegistryOutcomes(options.registryPath, result, options.now?.() ?? new Date());
  return {
    candidates: candidates.length,
    verified: result.verified.length,
    rejected: result.rejected.length,
    preserved: preserved.length,
    catalogPath,
    rejections: result.rejected,
  };
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
