import { readFile } from "node:fs/promises";
import { atomicJson } from "./atomic-file.ts";
import { withFileLock } from "./file-lock.ts";
import type { Ats, DiscoveryProvenance, DomainEvidence } from "./types.ts";
import { resolveSource } from "./source-verification.ts";

export type EnrichmentState = "unresolved" | "matched" | "evidence_ready" | "verified" | "rejected";
export type MatchMethod = "normalized_token" | "normalized_name" | "normalized_domain" | "search_result";

export interface CompanyMatch { companyName: string; companyDomain: string; method: MatchMethod; reference: string }
export interface IdentityEvidence { companyName: string; companyDomain: string; kind: DomainEvidence["kind"] | "provider_structured_domain"; reference: string; observedAt: string }
export interface LeadAttempt { attemptedAt: string; outcome: "success" | "transient_failure" | "permanent_failure"; category?: string; detail?: string; nextEligibleAt?: string; evidenceRank?: number }
export interface EnrichmentLead {
  sourceKey: string; sourceUrl: string; ats: Ats; token: string;
  discoveredFrom: DiscoveryProvenance[];
  companyMatches: CompanyMatch[];
  identityEvidence: IdentityEvidence[];
  attempts: LeadAttempt[];
  promotedAt?: string;
}
export interface EnrichmentRegistry { version: 1; updatedAt: string; leads: EnrichmentLead[] }

const evidenceRank: Record<IdentityEvidence["kind"], number> = {
  provider_structured_domain: 4,
  company_redirect: 3,
  company_registry: 2,
  authoritative_dataset: 1,
};

export function deriveLeadState(lead: EnrichmentLead): EnrichmentState {
  const latestAttempt = lead.attempts.at(-1);
  if (latestAttempt?.outcome === "permanent_failure" && !supersededFailure(lead, latestAttempt)) return "rejected";
  if (!lead.companyMatches.length) return lead.promotedAt && latestAttempt?.outcome === "success" ? "verified" : "unresolved";
  const qualifying = lead.identityEvidence.filter((evidence) => !["lever", "ashby"].includes(lead.ats) || ["provider_structured_domain", "company_redirect"].includes(evidence.kind));
  if (!qualifying.length) return lead.promotedAt && latestAttempt?.outcome === "success" ? "verified" : "matched";
  const winningRank = Math.max(...qualifying.map((evidence) => evidenceRank[evidence.kind]));
  const winningDomains = new Set(qualifying.filter((evidence) => evidenceRank[evidence.kind] === winningRank).map((evidence) => normalizeDomain(evidence.companyDomain)));
  if (winningDomains.size !== 1) return "rejected";
  const domain = [...winningDomains][0]!;
  const state = lead.companyMatches.some((match) => normalizeDomain(match.companyDomain) === domain) ? "evidence_ready" : "rejected";
  return state === "evidence_ready" && lead.promotedAt && latestAttempt?.outcome === "success" ? "verified" : state;
}

export function retryDisposition(lead: EnrichmentLead, now = new Date()): "fresh" | "retryable" | "cooling_down" | "repeatedly_failing" {
  if (!lead.attempts.length) return "fresh";
  const latest = lead.attempts.at(-1)!;
  if (latest.outcome !== "transient_failure") return "retryable";
  if (latest.nextEligibleAt && Date.parse(latest.nextEligibleAt) > now.getTime()) return "cooling_down";
  const consecutive = consecutiveTransientFailures(lead.attempts);
  return consecutive >= 3 ? "repeatedly_failing" : "retryable";
}

export function strongestEvidenceRank(lead: EnrichmentLead): number { return Math.max(0, ...lead.identityEvidence.map((evidence) => evidenceRank[evidence.kind])); }

export async function readEnrichmentRegistry(path: string): Promise<EnrichmentRegistry> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRegistry(value)) throw new Error(`Invalid enrichment registry: ${path}`);
    return value;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { version: 1, updatedAt: new Date(0).toISOString(), leads: [] };
    throw error;
  }
}

export async function mergeEnrichmentLeads(path: string, additions: EnrichmentLead[], now = new Date()): Promise<{ added: number; updated: number; total: number; bytes: number; lockHeldMs: number; durationMs: number }> {
  const startedAt = Date.now();
  const result = await withFileLock(path, async () => {
    const lockStartedAt = Date.now();
    const registry = await readEnrichmentRegistry(path);
    const byKey = new Map(registry.leads.map((lead) => [lead.sourceKey, lead]));
    let added = 0;
    let updated = 0;
    for (const addition of additions) {
      const current = byKey.get(addition.sourceKey);
      if (!current) { byKey.set(addition.sourceKey, canonicalLead(addition)); added += 1; continue; }
      byKey.set(addition.sourceKey, mergeLead(current, addition)); updated += 1;
    }
    const leads = [...byKey.values()].sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
    const value = { version: 1, updatedAt: now.toISOString(), leads } satisfies EnrichmentRegistry;
    await atomicJson(path, value);
    return { added, updated, total: leads.length, bytes: Buffer.byteLength(JSON.stringify(value)), lockHeldMs: Date.now() - lockStartedAt };
  }, { operation: "merge enrichment leads" });
  return { ...result, durationMs: Date.now() - startedAt };
}

export function transientAttempt(attemptedAt: Date, consecutiveFailures: number, category: string, detail: string): LeadAttempt {
  const delayMs = Math.min(7 * 86_400_000, 60_000 * 2 ** Math.max(0, consecutiveFailures - 1));
  return { attemptedAt: attemptedAt.toISOString(), outcome: "transient_failure", category, detail, nextEligibleAt: new Date(attemptedAt.getTime() + delayMs).toISOString() };
}

function mergeLead(left: EnrichmentLead, right: EnrichmentLead): EnrichmentLead {
  return canonicalLead({
    ...left,
    sourceUrl: right.sourceUrl,
    discoveredFrom: unique([...left.discoveredFrom, ...right.discoveredFrom]),
    companyMatches: unique([...left.companyMatches, ...right.companyMatches]),
    identityEvidence: unique([...left.identityEvidence, ...right.identityEvidence]),
    attempts: unique([...left.attempts, ...right.attempts]).sort((a, b) => a.attemptedAt.localeCompare(b.attemptedAt)),
    promotedAt: right.promotedAt ?? left.promotedAt,
  });
}
function canonicalLead(lead: EnrichmentLead): EnrichmentLead {
  const sorted = <T>(values: T[]) => unique(values).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return { ...lead, discoveredFrom: sorted(lead.discoveredFrom), companyMatches: sorted(lead.companyMatches), identityEvidence: sorted(lead.identityEvidence), attempts: unique(lead.attempts).sort((a, b) => a.attemptedAt.localeCompare(b.attemptedAt) || JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}
function unique<T>(values: T[]): T[] { return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()]; }
function normalizeDomain(value: string): string { return value.toLowerCase().replace(/^www\./, ""); }
function consecutiveTransientFailures(attempts: LeadAttempt[]): number { let count = 0; for (const attempt of [...attempts].reverse()) { if (attempt.outcome !== "transient_failure") break; count += 1; } return count; }
function isRegistry(value: unknown): value is EnrichmentRegistry {
  if (!isRecord(value) || value.version !== 1 || typeof value.updatedAt !== "string" || !Array.isArray(value.leads)) return false;
  return value.leads.every((lead) => isRecord(lead)
    && typeof lead.sourceKey === "string" && /^(greenhouse|lever|ashby|workday):.+/.test(lead.sourceKey)
    && typeof lead.sourceUrl === "string" && typeof lead.token === "string"
    && ["greenhouse", "lever", "ashby", "workday"].includes(String(lead.ats))
    && Array.isArray(lead.discoveredFrom) && lead.discoveredFrom.every(validProvenance)
    && Array.isArray(lead.companyMatches) && lead.companyMatches.every(validMatch)
    && Array.isArray(lead.identityEvidence) && lead.identityEvidence.every(validEvidence)
    && Array.isArray(lead.attempts) && lead.attempts.every(validAttempt)
    && sourceIdentityMatches(lead)
    && (lead.promotedAt === undefined || typeof lead.promotedAt === "string" && Number.isFinite(Date.parse(lead.promotedAt))));
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validProvenance(value: unknown): boolean { return isRecord(value) && ["search", "career_page", "provider_directory", "community", "dataset", "legacy"].includes(String(value.channel)) && typeof value.reference === "string"; }
function validMatch(value: unknown): boolean { return isRecord(value) && typeof value.companyName === "string" && typeof value.companyDomain === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value.companyDomain) && ["normalized_token", "normalized_name", "normalized_domain", "search_result"].includes(String(value.method)) && typeof value.reference === "string"; }
function validEvidence(value: unknown): boolean { return isRecord(value) && typeof value.companyName === "string" && typeof value.companyDomain === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value.companyDomain) && ["provider_structured_domain", "company_redirect", "company_registry", "authoritative_dataset"].includes(String(value.kind)) && typeof value.reference === "string" && typeof value.observedAt === "string" && Number.isFinite(Date.parse(value.observedAt)); }
function validAttempt(value: unknown): boolean { return isRecord(value) && typeof value.attemptedAt === "string" && Number.isFinite(Date.parse(value.attemptedAt)) && ["success", "transient_failure", "permanent_failure"].includes(String(value.outcome)) && (value.nextEligibleAt === undefined || typeof value.nextEligibleAt === "string" && Number.isFinite(Date.parse(value.nextEligibleAt))) && (value.category === undefined || typeof value.category === "string") && (value.detail === undefined || typeof value.detail === "string") && (value.evidenceRank === undefined || typeof value.evidenceRank === "number" && Number.isFinite(value.evidenceRank)); }
function sourceIdentityMatches(value: Record<string, unknown>): boolean {
  const source = resolveSource(String(value.sourceUrl));
  if (source) return source.ats === value.ats && source.token === value.token && `${source.ats}:${source.token.toLowerCase()}` === value.sourceKey;
  if (value.ats !== "workday" || typeof value.token !== "string" || typeof value.sourceKey !== "string") return false;
  try {
    const host = new URL(String(value.sourceUrl)).hostname.toLowerCase();
    return /\.myworkdayjobs\.com$/u.test(host) && value.token.startsWith(`${host}/`) && value.sourceKey === `workday:${value.token.toLowerCase()}`;
  } catch { return false; }
}
function supersededFailure(lead: EnrichmentLead, attempt: LeadAttempt): boolean { return attempt.category === "identity_mismatch" && lead.identityEvidence.some((evidence) => Date.parse(evidence.observedAt) > Date.parse(attempt.attemptedAt) && evidenceRank[evidence.kind] > (attempt.evidenceRank ?? 0)); }
