import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveLeadState, mergeEnrichmentLeads, readEnrichmentRegistry, retryDisposition, transientAttempt, type EnrichmentLead } from "../src/enrichment-registry.ts";

const lead = (overrides: Partial<EnrichmentLead> = {}): EnrichmentLead => ({
  sourceKey: "ashby:acme", sourceUrl: "https://jobs.ashbyhq.com/acme", ats: "ashby", token: "acme",
  discoveredFrom: [{ channel: "dataset", reference: "common-crawl" }], companyMatches: [], identityEvidence: [], attempts: [], ...overrides,
});

test("weak matches never accumulate into verification-ready identity", () => {
  const value = lead({ companyMatches: [
    { companyName: "Acme", companyDomain: "acme.test", method: "normalized_token", reference: "one" },
    { companyName: "Acme", companyDomain: "acme.test", method: "search_result", reference: "two" },
  ] });
  expect(deriveLeadState(value)).toBe("matched");
});

test("highest-trust evidence wins deterministically while same-rank conflicts quarantine", () => {
  const companyMatches = [{ companyName: "Acme", companyDomain: "acme.test", method: "normalized_token" as const, reference: "seed" }];
  const authoritative = { companyName: "Acme", companyDomain: "acme.test", kind: "authoritative_dataset" as const, reference: "yc", observedAt: "2026-08-10T00:00:00.000Z" };
  const redirect = { companyName: "Other", companyDomain: "other.test", kind: "company_redirect" as const, reference: "https://other.test/jobs", observedAt: "2026-08-10T00:00:00.000Z" };
  expect(deriveLeadState(lead({ ats: "greenhouse", companyMatches, identityEvidence: [redirect, authoritative] }))).toBe("rejected");
  expect(deriveLeadState(lead({ ats: "greenhouse", companyMatches: [...companyMatches, { ...companyMatches[0]!, companyName: "Other", companyDomain: "other.test" }], identityEvidence: [redirect, authoritative] }))).toBe("evidence_ready");
  expect(deriveLeadState(lead({ ats: "greenhouse", companyMatches, identityEvidence: [authoritative, { ...authoritative, companyDomain: "other.test" }] }))).toBe("rejected");
});

test("Lever and Ashby require provider or replayed redirect evidence", () => {
  const companyMatches = [{ companyName: "Acme", companyDomain: "acme.test", method: "normalized_token" as const, reference: "seed" }];
  const evidence = [{ companyName: "Acme", companyDomain: "acme.test", kind: "authoritative_dataset" as const, reference: "yc", observedAt: "2026-08-10T00:00:00.000Z" }];
  expect(deriveLeadState(lead({ companyMatches, identityEvidence: evidence }))).toBe("matched");
  expect(deriveLeadState(lead({ companyMatches, identityEvidence: [...evidence, { ...evidence[0]!, kind: "company_redirect", reference: "https://acme.test/jobs" }] }))).toBe("evidence_ready");
});

test("registry merges facts once per source and preserves prior campaigns", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "openings-enrichment-")), "leads.json");
  await mergeEnrichmentLeads(path, [lead()]);
  await mergeEnrichmentLeads(path, [lead({ discoveredFrom: [{ channel: "community", reference: "issue-1" }], companyMatches: [{ companyName: "Acme", companyDomain: "acme.test", method: "normalized_token", reference: "seed" }] })]);
  const registry = await readEnrichmentRegistry(path);
  expect(registry.leads).toHaveLength(1);
  expect(registry.leads[0]?.discoveredFrom).toHaveLength(2);
  expect(deriveLeadState(registry.leads[0]!)).toBe("matched");
});

test("repeated transient failures cool down and surface separately", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");
  const attempts = [1, 2, 3].map((count) => transientAttempt(new Date(now.getTime() + count), count, "unreachable", "down"));
  expect(retryDisposition(lead({ attempts }), now)).toBe("cooling_down");
  expect(retryDisposition(lead({ attempts }), new Date("2026-08-20T00:00:00.000Z"))).toBe("repeatedly_failing");
});

test("latest authoritative verification outcome can reject and restore a promoted lead", () => {
  const base = lead({ promotedAt: "2026-08-01T00:00:00.000Z", attempts: [{ attemptedAt: "2026-08-01T00:00:00.000Z", outcome: "success" }] });
  expect(deriveLeadState(base)).toBe("verified");
  expect(deriveLeadState({ ...base, attempts: [...base.attempts, { attemptedAt: "2026-08-02T00:00:00.000Z", outcome: "permanent_failure", category: "identity_mismatch" }] })).toBe("rejected");
  expect(deriveLeadState({ ...base, attempts: [...base.attempts, { attemptedAt: "2026-08-02T00:00:00.000Z", outcome: "permanent_failure" }, { attemptedAt: "2026-08-03T00:00:00.000Z", outcome: "success" }] })).toBe("verified");
});

test("completed attempts end an earlier transient cooldown", () => {
  const failure = transientAttempt(new Date("2026-08-10T00:00:00.000Z"), 1, "unreachable", "down");
  expect(retryDisposition(lead({ attempts: [failure, { attemptedAt: "2026-08-10T00:00:01.000Z", outcome: "success" }] }), new Date("2026-08-10T00:00:02.000Z"))).toBe("retryable");
  expect(retryDisposition(lead({ attempts: [failure, { attemptedAt: "2026-08-10T00:00:01.000Z", outcome: "permanent_failure" }] }), new Date("2026-08-10T00:00:02.000Z"))).toBe("retryable");
});

test("newer higher-trust evidence supersedes an older permanent rejection", () => {
  const rejected = lead({ ats: "greenhouse", companyMatches: [{ companyName: "Acme", companyDomain: "acme.test", method: "normalized_token", reference: "seed" }],
    identityEvidence: [{ companyName: "Acme", companyDomain: "acme.test", kind: "authoritative_dataset", reference: "old", observedAt: "2026-08-01T00:00:00.000Z" }],
    attempts: [{ attemptedAt: "2026-08-02T00:00:00.000Z", outcome: "permanent_failure", category: "identity_mismatch", evidenceRank: 1 }] });
  expect(deriveLeadState(rejected)).toBe("rejected");
  expect(deriveLeadState({ ...rejected, identityEvidence: [...rejected.identityEvidence, { companyName: "Acme", companyDomain: "acme.test", kind: "company_redirect", reference: "https://acme.test/jobs", observedAt: "2026-08-03T00:00:00.000Z" }] })).toBe("evidence_ready");
  expect(deriveLeadState({ ...rejected, attempts: [{ ...rejected.attempts[0]!, category: "no_country_jobs" }], identityEvidence: [...rejected.identityEvidence, { companyName: "Acme", companyDomain: "acme.test", kind: "company_redirect", reference: "https://acme.test/jobs", observedAt: "2026-08-03T00:00:00.000Z" }] })).toBe("rejected");
});

test("merging a lead seen again under a differently-cased slug keeps its original url and token", async () => {
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { mergeEnrichmentLeads, readEnrichmentRegistry } = await import("../src/enrichment-registry.ts");
  const dir = await mkdtemp(join(tmpdir(), "registry-")); const path = join(dir, "leads.json");
  const lead = (token: string, url: string) => ({ sourceKey: "ashby:adaptive", sourceUrl: url, ats: "ashby" as const, token, discoveredFrom: [{ channel: "dataset" as const, reference: "x" }], companyMatches: [], identityEvidence: [], attempts: [] });
  await writeFile(path, JSON.stringify({ version: 1, updatedAt: "2026-09-01T00:00:00.000Z", leads: [lead("adaptive", "https://jobs.ashbyhq.com/adaptive")] }));
  await mergeEnrichmentLeads(path, [lead("Adaptive", "https://jobs.ashbyhq.com/Adaptive")]);
  const registry = await readEnrichmentRegistry(path);
  expect(registry.leads).toHaveLength(1);
  expect(registry.leads[0]).toMatchObject({ token: "adaptive", sourceUrl: "https://jobs.ashbyhq.com/adaptive" });
  expect((await readFile(path, "utf8")).includes("/Adaptive")).toBe(false);
});
