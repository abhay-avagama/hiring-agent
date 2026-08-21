import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { atomicJson } from "./atomic-file.ts";
import { assertArtifactFile, openingsRootFor } from "./artifact-path.ts";
import { deriveLeadState, mergeEnrichmentLeads, readEnrichmentRegistry, type EnrichmentLead } from "./enrichment-registry.ts";
import { withFileLock } from "./file-lock.ts";
import { stampReport } from "./report-meta.ts";
import type { SourceCandidate } from "./types.ts";

export interface JoinedRecruiteeIdentity {
  token: string;
  companyName: string;
  companyDomain: string;
  reference: string;
  method: "normalized_token" | "normalized_domain";
  provenanceKind: "authoritative_dataset" | "company_owned_page" | "business_registry";
}

interface ArtifactOptions { artifactRoot: string; existingCompanyDomains?: string[]; now?: Date }
interface GenerationManifest { version: 1; generation: string; registryPath: string; candidatesPath: string; reportPath: string; identitiesPath: string }

const approvedDatasetReferences = new Set([".openings/company-domains.json", ".openings/lever-ashby-seeds.json", "data/companies-career-page.md"]);
const approvedBusinessRegistryDomains = ["mca.gov.in", "data.gov.in"];

export async function buildRecruiteeRoundArtifacts(identities: JoinedRecruiteeIdentity[], options: ArtifactOptions) {
  const root = resolve(options.artifactRoot);
  if (!root.split(sep).includes(".openings")) throw new Error("Round 5 artifact root must be under .openings");
  const securityRoot = openingsRootFor(root);
  const manifestPath = join(root, "current.json");
  await assertArtifactFile(manifestPath, securityRoot);
  const now = options.now ?? new Date();
  return withFileLock(manifestPath, async () => {
    const priorManifest = await readManifest(manifestPath, root);
    if (priorManifest) await assertArtifactFile(priorManifest.identitiesPath, securityRoot);
    const priorIdentities = priorManifest ? await readIdentities(priorManifest.identitiesPath) : [];
    const allIdentities = uniqueIdentities([...priorIdentities, ...identities].map(validateIdentity));
    const existing = new Set((options.existingCompanyDomains ?? []).map(normalizeDomain));
    const grouped = new Map<string, JoinedRecruiteeIdentity[]>();
    for (const identity of allIdentities) { const values = grouped.get(identity.token) ?? []; values.push(identity); grouped.set(identity.token, values); }

    const leads: EnrichmentLead[] = [];
    const candidates: SourceCandidate[] = [];
    const quarantines: Array<{ token: string; domains: string[] }> = [];
    const excluded: Array<{ token: string; companyDomain: string }> = [];
    for (const [token, values] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
      const domains = [...new Set(values.map((value) => value.companyDomain))].sort();
      if (domains.length !== 1) { quarantines.push({ token, domains }); continue; }
      const companyDomain = domains[0]!;
      if (existing.has(companyDomain)) { excluded.push({ token, companyDomain }); continue; }
      const primary = [...values].sort((left, right) => left.reference.localeCompare(right.reference) || left.companyName.localeCompare(right.companyName))[0]!;
      const sourceUrl = `https://${token}.recruitee.com`;
      const discoveredFrom = { channel: "dataset" as const, reference: primary.reference };
      const lead: EnrichmentLead = { sourceKey: `recruitee:${token}`, sourceUrl, ats: "recruitee", token, discoveredFrom: [discoveredFrom], companyMatches: values.map((value) => ({ companyName: value.companyName, companyDomain, method: value.method, reference: value.reference })), identityEvidence: [], attempts: [] };
      if (deriveLeadState(lead) !== "matched") throw new Error(`Round 5 lead ${token} did not derive matched state`);
      leads.push(lead);
      candidates.push({ companyName: primary.companyName, companyDomain, sourceUrl, discoveredFrom });
    }

    const generation = createHash("sha256").update(JSON.stringify({ now: now.toISOString(), identities: allIdentities, existing: [...existing].sort() })).digest("hex").slice(0, 20);
    const generationRoot = join(root, "generations", generation);
    const registryPath = join(generationRoot, "registry.json");
    const candidatesPath = join(generationRoot, "candidates.json");
    const reportPath = join(generationRoot, "join-report.json");
    const identitiesPath = join(generationRoot, "identities.json");
    for (const path of [registryPath, candidatesPath, reportPath, identitiesPath]) await assertArtifactFile(path, securityRoot);
    const report = stampReport("round5-recruitee-join:1", 1, { identities: allIdentities.length, matched: leads.length, quarantined: quarantines.length, excludedExisting: excluded.length, registryPath, candidatesPath, quarantines, excluded }, now);
    await atomicJson(registryPath, { version: 1, updatedAt: now.toISOString(), leads });
    await atomicJson(candidatesPath, candidates);
    await atomicJson(reportPath, report);
    await atomicJson(identitiesPath, allIdentities);
    const manifest: GenerationManifest = { version: 1, generation, registryPath, candidatesPath, reportPath, identitiesPath };
    await atomicJson(manifestPath, manifest);
    return { ...report, manifestPath, generation };
  }, { operation: "publish paired Round 5 Recruitee artifacts" });
}

export async function prepareRecruiteeRoundArtifacts(identityPath: string, catalogPath: string, options: ArtifactOptions) {
  const identities = await readIdentities(identityPath);
  const catalog: unknown = JSON.parse(await readFile(catalogPath, "utf8"));
  if (!record(catalog)) throw new Error("Round 5 catalog must be a JSON object");
  const existingCompanyDomains = Object.values(catalog).flatMap((value) => record(value) && typeof value.companyDomain === "string" ? [value.companyDomain] : []);
  return buildRecruiteeRoundArtifacts(identities, { ...options, existingCompanyDomains });
}

export async function mergeAttemptedRoundLeads(isolatedRegistryPath: string, sharedRegistryPath: string, now = new Date()) {
  if (resolve(isolatedRegistryPath) === resolve(sharedRegistryPath)) throw new Error("Isolated and shared enrichment registries must be different files");
  const root = roundRootFromRegistry(isolatedRegistryPath);
  await assertArtifactFile(isolatedRegistryPath, openingsRootFor(root));
  const manifestPath = join(root, "current.json");
  await assertArtifactFile(manifestPath, openingsRootFor(root));
  // Publication and merging share this outer lock; the registry lock is always acquired second.
  return withFileLock(manifestPath, async () => {
    const manifest = await readManifest(manifestPath, root);
    if (!manifest || resolve(manifest.registryPath) !== resolve(isolatedRegistryPath)) throw new Error("Isolated registry must be the current Round 5 generation registry");
    return withFileLock(isolatedRegistryPath, async () => {
      const isolated = await readEnrichmentRegistry(isolatedRegistryPath);
      const attempted = isolated.leads.filter((lead) => lead.attempts.length > 0);
      const merge = await mergeEnrichmentLeads(sharedRegistryPath, attempted, now);
      return { selected: attempted.length, ...merge };
    }, { operation: "merge attempted Round 5 Recruitee leads" });
  }, { operation: "select current Round 5 Recruitee generation" });
}

async function readManifest(path: string, root: string): Promise<GenerationManifest | undefined> { try { const value: unknown = JSON.parse(await readFile(path, "utf8")); if (!record(value) || value.version !== 1 || typeof value.generation !== "string" || !/^[a-f0-9]{20}$/.test(value.generation) || typeof value.registryPath !== "string" || typeof value.candidatesPath !== "string" || typeof value.reportPath !== "string" || typeof value.identitiesPath !== "string") throw new Error("Invalid Round 5 artifact manifest"); const generationRoot = join(root, "generations", value.generation); const expected: GenerationManifest = { version: 1, generation: value.generation, registryPath: join(generationRoot, "registry.json"), candidatesPath: join(generationRoot, "candidates.json"), reportPath: join(generationRoot, "join-report.json"), identitiesPath: join(generationRoot, "identities.json") }; const supplied = value as unknown as GenerationManifest; for (const key of ["registryPath", "candidatesPath", "reportPath", "identitiesPath"] as const) if (resolve(supplied[key]) !== resolve(expected[key])) throw new Error("Round 5 manifest contains an unexpected artifact path"); return expected; } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; } }
async function readIdentities(path: string): Promise<JoinedRecruiteeIdentity[]> { const value: unknown = JSON.parse(await readFile(path, "utf8")); if (!Array.isArray(value)) throw new Error("Round 5 joined identities must be a JSON array"); return value.map(parseIdentity); }
function uniqueIdentities(values: JoinedRecruiteeIdentity[]) { return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()].sort((a, b) => a.token.localeCompare(b.token) || a.companyDomain.localeCompare(b.companyDomain) || a.reference.localeCompare(b.reference)); }
function validateIdentity(value: JoinedRecruiteeIdentity): JoinedRecruiteeIdentity { const token = value.token.trim().toLowerCase(); const companyName = value.companyName.trim(); const companyDomain = normalizeDomain(value.companyDomain); const reference = value.reference.trim(); if (!/^[a-z0-9-]+$/.test(token)) throw new Error(`Invalid Recruitee token: ${value.token}`); if (!companyName) throw new Error("Joined companyName must be non-empty"); if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(companyDomain)) throw new Error(`Invalid joined company domain: ${value.companyDomain}`); if (!["normalized_token", "normalized_domain"].includes(value.method)) throw new Error("Round 5 identity method must be an explicit exact non-search match"); if (!["authoritative_dataset", "company_owned_page", "business_registry"].includes(value.provenanceKind)) throw new Error("Round 5 identity requires authoritative provenance"); if (value.provenanceKind === "authoritative_dataset" && !approvedDatasetReferences.has(reference)) throw new Error("Round 5 authoritative_dataset reference is not an approved dataset"); if (value.provenanceKind !== "authoritative_dataset") { let url: URL; try { url = new URL(reference); } catch { throw new Error("Manual Round 5 identity references must be HTTPS URLs"); } if (url.protocol !== "https:") throw new Error("Manual Round 5 identity references must be HTTPS URLs"); if (value.provenanceKind === "company_owned_page" && !domainContains(url.hostname, companyDomain)) throw new Error("Company-owned identity reference must match the joined company domain"); if (value.provenanceKind === "business_registry" && !approvedBusinessRegistryDomains.some((domain) => domainContains(url.hostname, domain))) throw new Error("Round 5 business_registry reference is not an approved business registry"); } return { ...value, token, companyName, companyDomain, reference }; }
function parseIdentity(value: unknown): JoinedRecruiteeIdentity { if (!record(value) || typeof value.token !== "string" || typeof value.companyName !== "string" || typeof value.companyDomain !== "string" || typeof value.reference !== "string" || typeof value.method !== "string" || typeof value.provenanceKind !== "string") throw new Error("Each Round 5 identity requires token, companyName, companyDomain, reference, method, and provenanceKind strings"); return validateIdentity(value as unknown as JoinedRecruiteeIdentity); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function normalizeDomain(value: string): string { return value.trim().toLowerCase().replace(/^www\./, ""); }
function domainContains(host: string, domain: string) { const value = normalizeDomain(host); return value === domain || value.endsWith(`.${domain}`); }
function roundRootFromRegistry(path: string): string { const absolute = resolve(path); const marker = `${sep}generations${sep}`; const index = absolute.lastIndexOf(marker); if (index < 0) throw new Error("Isolated registry must belong to a Round 5 generation"); return absolute.slice(0, index); }
