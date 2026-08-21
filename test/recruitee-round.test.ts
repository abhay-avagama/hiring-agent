import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRecruiteeRoundArtifacts, mergeAttemptedRoundLeads } from "../src/recruitee-round.ts";
import { deriveLeadState, readEnrichmentRegistry } from "../src/enrichment-registry.ts";
import { withFileLock } from "../src/file-lock.ts";

test("Round 5 identity joins create paired matched artifacts without identity evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "openings-recruitee-round-"));
  const artifactRoot = join(root, ".openings", "round5-recruitee");
  const result = await buildRecruiteeRoundArtifacts([
    { token: "acme", companyName: "Acme", companyDomain: "acme.test", reference: ".openings/company-domains.json", method: "normalized_token", provenanceKind: "authoritative_dataset" },
    { token: "conflict", companyName: "Conflict", companyDomain: "one.test", reference: ".openings/company-domains.json", method: "normalized_token", provenanceKind: "authoritative_dataset" },
    { token: "conflict", companyName: "Conflict", companyDomain: "two.test", reference: ".openings/company-domains.json", method: "normalized_token", provenanceKind: "authoritative_dataset" },
    { token: "known", companyName: "Known", companyDomain: "known.test", reference: ".openings/company-domains.json", method: "normalized_token", provenanceKind: "authoritative_dataset" },
  ], { artifactRoot, existingCompanyDomains: ["known.test"], now: new Date("2026-08-21T00:00:00.000Z") });

  const registry = await readEnrichmentRegistry(result.registryPath);
  const candidates = JSON.parse(await readFile(result.candidatesPath, "utf8"));
  expect(result).toEqual(expect.objectContaining({ matched: 1, quarantined: 1, excludedExisting: 1 }));
  expect(registry.leads).toHaveLength(1);
  expect(deriveLeadState(registry.leads[0]!)).toBe("matched");
  expect(registry.leads[0]!.identityEvidence).toEqual([]);
  expect(candidates).toEqual([expect.objectContaining({ companyName: "Acme", companyDomain: "acme.test", sourceUrl: "https://acme.recruitee.com" })]);

  const second = await buildRecruiteeRoundArtifacts([
    { token: "beta", companyName: "Beta", companyDomain: "beta.test", reference: ".openings/company-domains.json", method: "normalized_token", provenanceKind: "authoritative_dataset" },
  ], { artifactRoot, existingCompanyDomains: ["known.test"], now: new Date("2026-08-21T01:00:00.000Z") });
  expect((await readEnrichmentRegistry(second.registryPath)).leads.map((lead) => lead.token)).toEqual(["acme", "beta"]);
  await expect(mergeAttemptedRoundLeads(result.registryPath, join(root, "shared.json"))).rejects.toThrow("current Round 5 generation");
});

test("only attempted isolated leads merge into shared enrichment state", async () => {
  const root = await mkdtemp(join(tmpdir(), "openings-recruitee-round-"));
  const artifactRoot = join(root, ".openings", "round5-recruitee");
  const shared = join(root, "shared.json");
  const base = (token: string, attempts: unknown[]) => ({ sourceKey: `recruitee:${token}`, sourceUrl: `https://${token}.recruitee.com`, ats: "recruitee", token, discoveredFrom: [{ channel: "dataset", reference: "round5" }], companyMatches: [{ companyName: token, companyDomain: `${token}.test`, method: "normalized_token", reference: "round5" }], identityEvidence: [], attempts });
  const built = await buildRecruiteeRoundArtifacts([
    { token: "attempted", companyName: "attempted", companyDomain: "attempted.test", reference: ".openings/company-domains.json", method: "normalized_token", provenanceKind: "authoritative_dataset" },
    { token: "untouched", companyName: "untouched", companyDomain: "untouched.test", reference: ".openings/company-domains.json", method: "normalized_token", provenanceKind: "authoritative_dataset" },
  ], { artifactRoot, now: new Date("2026-08-21T00:00:00.000Z") });
  await writeFile(built.registryPath, JSON.stringify({ version: 1, updatedAt: "2026-08-21T00:00:00.000Z", leads: [base("attempted", [{ attemptedAt: "2026-08-21T01:00:00.000Z", outcome: "permanent_failure", category: "identity_mismatch" }]), base("untouched", [])] }));

  const result = await mergeAttemptedRoundLeads(built.registryPath, shared, new Date("2026-08-21T02:00:00.000Z"));
  const registry = await readEnrichmentRegistry(shared);
  expect(result.selected).toBe(1);
  expect(registry.leads.map((lead) => lead.token)).toEqual(["attempted"]);
});

test("Round 5 artifacts reject search-result joins and aliased output paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "openings-recruitee-round-"));
  const sharedPath = join(root, "same.json");
  const artifactRoot = join(root, ".openings", "round5-recruitee");
  await expect(buildRecruiteeRoundArtifacts([{ token: "acme", companyName: "Acme", companyDomain: "acme.test", reference: ".openings/company-domains.json", method: "search_result" as never, provenanceKind: "authoritative_dataset" }], {
    artifactRoot,
  })).rejects.toThrow("exact non-search match");
  await expect(buildRecruiteeRoundArtifacts([{ token: "acme", companyName: "Acme", companyDomain: "acme.test", reference: "not-a-url", method: "normalized_domain", provenanceKind: "company_owned_page" }], {
    artifactRoot,
  })).rejects.toThrow("must be HTTPS URLs");
  await expect(buildRecruiteeRoundArtifacts([{ token: "acme", companyName: "Acme", companyDomain: "acme.test", reference: "search-result", method: "normalized_domain", provenanceKind: "authoritative_dataset" }], {
    artifactRoot,
  })).rejects.toThrow("not an approved dataset");
  await expect(buildRecruiteeRoundArtifacts([{ token: "acme", companyName: "Acme", companyDomain: "acme.test", reference: "https://example.com/company/acme", method: "normalized_domain", provenanceKind: "business_registry" }], {
    artifactRoot,
  })).rejects.toThrow("not an approved business registry");
  await expect(buildRecruiteeRoundArtifacts([{ token: "acme", companyName: "Different Company", companyDomain: "different.test", reference: ".openings/company-domains.json", method: "normalized_token", provenanceKind: "authoritative_dataset" }], {
    artifactRoot,
  })).rejects.toThrow("does not exactly match the Recruitee token");
  await expect(buildRecruiteeRoundArtifacts([], { artifactRoot: join(root, "outside") })).rejects.toThrow("must be under .openings");
  await expect(mergeAttemptedRoundLeads(sharedPath, sharedPath)).rejects.toThrow("must be different files");
});

test("Round 5 artifacts reject nested symlink escapes before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "openings-recruitee-round-"));
  const openings = join(root, ".openings");
  const outside = join(root, "outside");
  await mkdir(openings);
  await mkdir(outside);
  await symlink(outside, join(openings, "round5-recruitee"));

  await expect(buildRecruiteeRoundArtifacts([], { artifactRoot: join(openings, "round5-recruitee") })).rejects.toThrow("must not be symbolic links");
});

test("Round 5 rejects symlinked manifest and registry files", async () => {
  const root = await mkdtemp(join(tmpdir(), "openings-recruitee-round-"));
  const artifactRoot = join(root, ".openings", "round5-recruitee");
  const identity = { token: "acme", companyName: "Acme", companyDomain: "acme.test", reference: ".openings/company-domains.json", method: "normalized_token" as const, provenanceKind: "authoritative_dataset" as const };
  const built = await buildRecruiteeRoundArtifacts([identity], { artifactRoot });
  const outside = join(root, "outside.json");
  await writeFile(outside, "[]\n");

  await rename(built.registryPath, `${built.registryPath}.real`);
  await symlink(outside, built.registryPath);
  await expect(mergeAttemptedRoundLeads(built.registryPath, join(root, "shared.json"))).rejects.toThrow("files must not be symbolic links");

  await rename(join(artifactRoot, "current.json"), join(artifactRoot, "current.real.json"));
  await symlink(outside, join(artifactRoot, "current.json"));
  await expect(buildRecruiteeRoundArtifacts([identity], { artifactRoot })).rejects.toThrow("files must not be symbolic links");

  const secondRoot = join(root, ".openings", "round5-identities");
  const second = await buildRecruiteeRoundArtifacts([identity], { artifactRoot: secondRoot });
  const identitiesPath = join(secondRoot, "generations", second.generation, "identities.json");
  await rename(identitiesPath, `${identitiesPath}.real`);
  await symlink(outside, identitiesPath);
  await expect(buildRecruiteeRoundArtifacts([identity], { artifactRoot: secondRoot })).rejects.toThrow("files must not be symbolic links");
});

test("current-generation merge serializes concurrent publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "openings-recruitee-round-"));
  const artifactRoot = join(root, ".openings", "round5-recruitee");
  const identity = { token: "acme", companyName: "Acme", companyDomain: "acme.test", reference: ".openings/company-domains.json", method: "normalized_token" as const, provenanceKind: "authoritative_dataset" as const };
  const built = await buildRecruiteeRoundArtifacts([identity], { artifactRoot, now: new Date("2026-08-21T00:00:00.000Z") });
  let releaseRegistry!: () => void;
  let registryHeld!: () => void;
  const held = new Promise<void>((resolve) => { registryHeld = resolve; });
  const release = new Promise<void>((resolve) => { releaseRegistry = resolve; });
  const blocker = withFileLock(built.registryPath, async () => { registryHeld(); await release; });
  await held;

  const merging = mergeAttemptedRoundLeads(built.registryPath, join(root, "shared.json"));
  await Bun.sleep(10);
  let published = false;
  const publishing = buildRecruiteeRoundArtifacts([{ ...identity, token: "beta", companyName: "Beta", companyDomain: "beta.test" }], { artifactRoot, now: new Date("2026-08-21T01:00:00.000Z") }).then((value) => { published = true; return value; });
  await Bun.sleep(10);
  expect(published).toBe(false);
  releaseRegistry();
  await blocker;
  await merging;
  const next = await publishing;
  expect(next.generation).not.toBe(built.generation);
});
