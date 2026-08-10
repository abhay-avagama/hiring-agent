import { readFile } from "node:fs/promises";
import { atomicJson } from "./atomic-file.ts";
import { deriveLeadState, mergeEnrichmentLeads, readEnrichmentRegistry, retryDisposition, type CompanyMatch, type EnrichmentLead, type IdentityEvidence } from "./enrichment-registry.ts";
import { stampReport, type ReportMeta } from "./report-meta.ts";
import { mergeSourceCandidates } from "./source-discovery.ts";
import type { SourceCandidate } from "./types.ts";

interface CompanySeed { companyName: string; companyDomain: string }
export interface SourceEnrichmentReport extends ReportMeta {
  registryPath: string; companiesChecked: number; leadsChecked: number; matched: number; evidenceReady: number; rejected: number; promoted: number; candidatesPath: string;
  states: Record<string, number>;
  retry: Record<string, number>;
  registryBytes: number; registryLockHeldMs: number; registryMergeDurationMs: number;
}

export async function enrichSourcesFromCompanies(registryPath: string, companiesPath: string, candidatesPath: string, reportPath: string, options: { evidenceKind?: "authoritative_dataset" | "company_registry"; now?: Date } = {}): Promise<SourceEnrichmentReport> {
  const now = options.now ?? new Date();
  const registry = await readEnrichmentRegistry(registryPath);
  const companies = await readCompanies(companiesPath);
  const additions: EnrichmentLead[] = [];
  for (const lead of registry.leads) {
    const matches = companies.filter((company) => sourceMatchesCompany(lead.token, company));
    if (matches.length !== 1) continue;
    const company = matches[0]!;
    const match: CompanyMatch = { ...company, method: "normalized_token", reference: companiesPath };
    const evidence: IdentityEvidence[] = options.evidenceKind ? [{ ...company, kind: options.evidenceKind, reference: companiesPath, observedAt: now.toISOString() }] : [];
    additions.push({ ...lead, companyMatches: [match], identityEvidence: evidence });
  }
  const merge = await mergeEnrichmentLeads(registryPath, additions, now);
  const enriched = await readEnrichmentRegistry(registryPath);
  const candidates: SourceCandidate[] = enriched.leads.flatMap((lead) => {
    if (deriveLeadState(lead) !== "evidence_ready") return [];
    if (["cooling_down", "repeatedly_failing"].includes(retryDisposition(lead, now))) return [];
    const identity = winningIdentity(lead);
    if (!identity) return [];
    return [{ companyName: identity.companyName, companyDomain: identity.companyDomain, sourceUrl: lead.sourceUrl,
      discoveredFrom: lead.discoveredFrom[0] ?? { channel: "dataset", reference: companiesPath },
      domainEvidence: { kind: identity.kind === "provider_structured_domain" ? "authoritative_dataset" : identity.kind, reference: identity.reference } }];
  });
  const promoted = await mergeSourceCandidates(candidatesPath, candidates);
  const states = countStates(enriched.leads);
  const retry = countRetry(enriched.leads, now);
  const report = stampReport("source-enrichment:1", 1, {
    registryPath, companiesChecked: companies.length, leadsChecked: enriched.leads.length,
    matched: states.matched ?? 0, evidenceReady: states.evidence_ready ?? 0, rejected: states.rejected ?? 0,
    promoted, candidatesPath, states, retry, registryBytes: merge.bytes, registryLockHeldMs: merge.lockHeldMs, registryMergeDurationMs: merge.durationMs,
  });
  await atomicJson(reportPath, report);
  return report;
}

function winningIdentity(lead: EnrichmentLead): IdentityEvidence | undefined {
  const qualifying = lead.identityEvidence.filter((evidence) => !["lever", "ashby"].includes(lead.ats) || ["provider_structured_domain", "company_redirect"].includes(evidence.kind));
  const rank = { provider_structured_domain: 4, company_redirect: 3, company_registry: 2, authoritative_dataset: 1 } as const;
  return [...qualifying].sort((left, right) => rank[right.kind] - rank[left.kind] || left.companyDomain.localeCompare(right.companyDomain))[0];
}
function countStates(leads: EnrichmentLead[]): Record<string, number> { const counts: Record<string, number> = {}; for (const lead of leads) { const state = deriveLeadState(lead); counts[state] = (counts[state] ?? 0) + 1; } return counts; }
function countRetry(leads: EnrichmentLead[], now: Date): Record<string, number> { const counts: Record<string, number> = {}; for (const lead of leads) { const state = retryDisposition(lead, now); counts[state] = (counts[state] ?? 0) + 1; } return counts; }
async function readCompanies(path: string): Promise<CompanySeed[]> { const value: unknown = JSON.parse(await readFile(path, "utf8")); if (!Array.isArray(value) || !value.every((company) => isRecord(company) && typeof company.companyName === "string" && company.companyName.trim() && typeof company.companyDomain === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(company.companyDomain))) throw new Error("Company seed file must contain valid companyName and companyDomain entries"); return value.map((company) => ({ companyName: String(company.companyName).trim(), companyDomain: String(company.companyDomain).toLowerCase().replace(/^www\./, "") })); }
function sourceMatchesCompany(token: string, company: CompanySeed): boolean { const normalize = (value: string) => value.toLowerCase().replace(/\b(inc|llc|ltd|limited|corp|corporation|company)\b/g, "").replace(/[^a-z0-9]/g, ""); const tenant = token.includes("myworkdayjobs.com/") ? token.split("/")[1] : token; const source = normalize(tenant ?? token); const name = normalize(company.companyName); const domain = normalize(company.companyDomain.replace(/^www\./, "").split(".")[0] ?? ""); return source.length >= 3 && (source === name || source === domain); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
