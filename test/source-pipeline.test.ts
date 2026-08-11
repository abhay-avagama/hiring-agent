import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runSourceVerification } from "../src/source-pipeline.ts";
import { mergeEnrichmentLeads, readEnrichmentRegistry, deriveLeadState } from "../src/enrichment-registry.ts";

test("the verification pipeline writes only verified sources to the generated catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-sources-"));
  const candidatesPath = join(directory, "candidates.json");
  const catalogPath = join(directory, "companies.json");
  await writeFile(candidatesPath, JSON.stringify([
    { companyName: "Acme", companyDomain: "acme.test", sourceUrl: "https://jobs.lever.co/acme", discoveredFrom: { channel: "community", reference: "issue-1" } },
    { companyName: "Bad", companyDomain: "bad.test", sourceUrl: "https://example.test/jobs", discoveredFrom: { channel: "dataset", reference: "row-2" } },
    { companyName: 42, companyDomain: "malformed.test" },
  ]));

  const report = await runSourceVerification(candidatesPath, catalogPath, {
    fetch: async () => Response.json([{ id: "1", text: "Engineer", hostedUrl: "https://jobs.lever.co/acme/1", companyWebsite: "https://acme.test" }]),
  });

  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  expect(Object.keys(catalog)).toEqual(["acme"]);
  expect(catalog.acme).toEqual(expect.objectContaining({ name: "Acme", ats: "lever", token: "acme" }));
  expect(report).toEqual(expect.objectContaining({ candidates: 3, verified: 1, rejected: 2, preserved: 0 }));
  expect(report.rejections[0]).toEqual(expect.objectContaining({ companyName: "Bad", reason: "unsupported_source" }));
  expect(report.rejections[1]).toEqual(expect.objectContaining({ reason: "invalid_candidate" }));
});

test("transient verification failures preserve the previously verified catalog entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-sources-"));
  const candidatesPath = join(directory, "candidates.json");
  const catalogPath = join(directory, "companies.json");
  await writeFile(candidatesPath, JSON.stringify([
    { companyName: "Acme", companyDomain: "acme.test", sourceUrl: "https://jobs.lever.co/acme", discoveredFrom: { channel: "community", reference: "issue-1" } },
  ]));
  await writeFile(catalogPath, JSON.stringify({ acme: {
    name: "Acme", ats: "lever", token: "acme", companyDomain: "acme.test", sourceUrl: "https://jobs.lever.co/acme",
    discoveredFrom: { channel: "community", reference: "issue-1" },
    verification: { checkedAt: "2026-08-01T00:00:00.000Z", canonicalSourceUrl: "https://jobs.lever.co/acme", observedCompanyName: "Acme", identityEvidence: "structured_domain_link", contentType: "application/json", payloadVersion: "lever-postings:v0", jobCount: 1 },
  } }));

  const report = await runSourceVerification(candidatesPath, catalogPath, { fetch: async () => new Response("down", { status: 503 }) });
  expect(report.preserved).toBe(1);
  expect(report.retryableFailures).toBe(1);
  expect(JSON.parse(await readFile(catalogPath, "utf8")).acme.name).toBe("Acme");
});

test("verification records success and transient retry facts in the enrichment registry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-pipeline-registry-"));
  const candidatesPath = join(directory, "candidates.json");
  const catalogPath = join(directory, "companies.json");
  const registryPath = join(directory, "leads.json");
  const candidates = [
    { companyName: "Acme", companyDomain: "acme.test", sourceUrl: "https://job-boards.greenhouse.io/acme", discoveredFrom: { channel: "dataset", reference: "yc" } },
    { companyName: "Down", companyDomain: "down.test", sourceUrl: "https://job-boards.greenhouse.io/down", discoveredFrom: { channel: "dataset", reference: "yc" } },
  ];
  await writeFile(candidatesPath, JSON.stringify(candidates));
  await mergeEnrichmentLeads(registryPath, candidates.map((candidate) => ({ sourceKey: `greenhouse:${candidate.companyName.toLowerCase()}`, sourceUrl: candidate.sourceUrl, ats: "greenhouse" as const, token: candidate.companyName.toLowerCase(), discoveredFrom: [candidate.discoveredFrom as { channel: "dataset"; reference: string }], companyMatches: [{ companyName: candidate.companyName, companyDomain: candidate.companyDomain, method: "normalized_token" as const, reference: "yc" }], identityEvidence: [{ companyName: candidate.companyName, companyDomain: candidate.companyDomain, kind: "authoritative_dataset" as const, reference: "yc", observedAt: "2026-08-09T00:00:00.000Z" }], attempts: [] })));
  await runSourceVerification(candidatesPath, catalogPath, { registryPath, now: () => new Date("2026-08-10T00:00:00.000Z"), fetch: async (input) => String(input).includes("/down/") ? new Response("down", { status: 503 }) : Response.json({ jobs: [{ company_name: "Acme" }] }) });
  const registry = await readEnrichmentRegistry(registryPath);
  expect(deriveLeadState(registry.leads.find((lead) => lead.token === "acme")!)).toBe("verified");
  expect(registry.leads.find((lead) => lead.token === "down")?.attempts[0]).toEqual(expect.objectContaining({ outcome: "transient_failure", nextEligibleAt: "2026-08-10T00:01:00.000Z" }));
  let downRequests = 0;
  const deferredReport = await runSourceVerification(candidatesPath, catalogPath, { registryPath, now: () => new Date("2026-08-10T00:00:30.000Z"), fetch: async (input) => { if (String(input).includes("/down/")) downRequests += 1; return Response.json({ jobs: [{ company_name: "Acme" }] }); } });
  expect(downRequests).toBe(0);
  expect(deferredReport).toEqual(expect.objectContaining({ deferred: 1, rejected: 0, preserved: 0, carriedForward: 0 }));
  expect((await readEnrichmentRegistry(registryPath)).leads.find((lead) => lead.token === "down")?.attempts).toHaveLength(1);
  await runSourceVerification(candidatesPath, catalogPath, { registryPath, retryDeferred: true, now: () => new Date("2026-08-10T00:00:31.000Z"), fetch: async (input) => { if (String(input).includes("/down/")) downRequests += 1; return Response.json({ jobs: [{ company_name: String(input).includes("/down/") ? "Down" : "Acme" }] }); } });
  expect(downRequests).toBe(1);
});

test("verification limits select new candidates first and preserve sources outside the batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-sources-batch-"));
  const candidatesPath = join(directory, "candidates.json");
  const catalogPath = join(directory, "companies.json");
  const candidates = ["old", "newone", "newtwo"].map((name) => ({
    companyName: name, companyDomain: `${name}.test`, sourceUrl: `https://job-boards.greenhouse.io/${name}`,
    discoveredFrom: { channel: "dataset", reference: "campaign" },
  }));
  await writeFile(candidatesPath, JSON.stringify(candidates));
  await writeFile(catalogPath, JSON.stringify({ old: {
    name: "old", ats: "greenhouse", token: "old", companyDomain: "old.test", sourceUrl: "https://job-boards.greenhouse.io/old",
    discoveredFrom: { channel: "dataset", reference: "campaign" },
    verification: { checkedAt: "2026-08-01T00:00:00.000Z", canonicalSourceUrl: "https://job-boards.greenhouse.io/old", observedCompanyName: "old", identityEvidence: "provider_company_name", contentType: "application/json", payloadVersion: "greenhouse-job-board:v1", jobCount: 1 },
  } }));
  const requested: string[] = [];

  const report = await runSourceVerification(candidatesPath, catalogPath, {
    limit: 1,
    fetch: async (input) => {
      requested.push(String(input));
      const token = String(input).split("/boards/")[1]?.split("/")[0] ?? "unknown";
      return Response.json({ jobs: [{ company_name: token }] });
    },
  });

  expect(requested[0]).toContain("/newone/");
  expect(report).toEqual(expect.objectContaining({ candidates: 3, newCandidates: 2, selected: 1, selectedNew: 1, deferred: 2, retryableFailures: 0, carriedForward: 1 }));
  expect(Object.keys(JSON.parse(await readFile(catalogPath, "utf8")))).toEqual(["newone", "old"]);
});

test("a batch candidate cannot overwrite an unrelated verified catalog slug", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-sources-collision-"));
  const candidatesPath = join(directory, "candidates.json");
  const catalogPath = join(directory, "companies.json");
  await writeFile(candidatesPath, JSON.stringify([{ slug: "acme", companyName: "Attacker", companyDomain: "attacker.test", sourceUrl: "https://job-boards.greenhouse.io/attacker", discoveredFrom: { channel: "dataset", reference: "campaign" } }]));
  await writeFile(catalogPath, JSON.stringify({ acme: {
    name: "Acme", ats: "greenhouse", token: "acme", companyDomain: "acme.test", sourceUrl: "https://job-boards.greenhouse.io/acme",
    discoveredFrom: { channel: "dataset", reference: "trusted" }, verification: { checkedAt: "2026-08-01T00:00:00.000Z", canonicalSourceUrl: "https://job-boards.greenhouse.io/acme", observedCompanyName: "Acme", identityEvidence: "provider_company_name", contentType: "application/json", payloadVersion: "greenhouse-job-board:v1", jobCount: 1 },
  } }));
  let requests = 0;

  const report = await runSourceVerification(candidatesPath, catalogPath, { limit: 1, fetch: async () => { requests += 1; return Response.json({ jobs: [{ company_name: "Attacker" }] }); } });

  expect(requests).toBe(0);
  expect(report.rejections[0]?.reason).toBe("duplicate_slug");
  expect(JSON.parse(await readFile(catalogPath, "utf8")).acme.companyDomain).toBe("acme.test");
});

test("successive one-item batches rotate past failures and refresh the oldest catalog sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-sources-rotation-"));
  const candidatesPath = join(directory, "candidates.json");
  const catalogPath = join(directory, "companies.json");
  const known = [
    { name: "Newest", checkedAt: "2026-08-03T00:00:00.000Z" },
    { name: "Oldest", checkedAt: "2026-08-01T00:00:00.000Z" },
    { name: "Middle", checkedAt: "2026-08-02T00:00:00.000Z" },
  ];
  await writeFile(candidatesPath, JSON.stringify([
    { companyName: "Quarantined", companyDomain: "quarantined.test", sourceUrl: "https://example.test/jobs", discoveredFrom: { channel: "legacy", reference: "known rejection" } },
    ...known.map(({ name }) => ({ companyName: name, companyDomain: `${name.toLowerCase()}.test`, sourceUrl: `https://job-boards.greenhouse.io/${name.toLowerCase()}`, discoveredFrom: { channel: "dataset", reference: "campaign" } })),
  ]));
  await writeFile(catalogPath, JSON.stringify(Object.fromEntries(known.map(({ name, checkedAt }) => [name.toLowerCase(), {
    name, ats: "greenhouse", token: name.toLowerCase(), companyDomain: `${name.toLowerCase()}.test`, sourceUrl: `https://job-boards.greenhouse.io/${name.toLowerCase()}`,
    discoveredFrom: { channel: "dataset", reference: "campaign" }, verification: { checkedAt, canonicalSourceUrl: `https://job-boards.greenhouse.io/${name.toLowerCase()}`, observedCompanyName: name, identityEvidence: "provider_company_name", contentType: "application/json", payloadVersion: "greenhouse-job-board:v1", jobCount: 1 },
  }]))));
  const requested: string[] = [];
  const fetch = async (input: string | URL) => {
    const token = String(input).split("/boards/")[1]?.split("/")[0] ?? "unknown";
    requested.push(token);
    return Response.json({ jobs: [{ company_name: token }] });
  };

  await runSourceVerification(candidatesPath, catalogPath, { limit: 1, now: () => new Date("2026-08-10T00:00:00.000Z"), fetch });
  await runSourceVerification(candidatesPath, catalogPath, { limit: 1, now: () => new Date("2026-08-11T00:00:00.000Z"), fetch });
  await runSourceVerification(candidatesPath, catalogPath, { limit: 1, now: () => new Date("2026-08-12T00:00:00.000Z"), fetch });

  expect(requested).toEqual(["oldest", "middle"]);
});

test("a corrupt batch ledger fails closed instead of silently resetting rotation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-sources-ledger-"));
  const candidatesPath = join(directory, "candidates.json");
  const catalogPath = join(directory, "companies.json");
  await writeFile(candidatesPath, "[]");
  await writeFile(`${catalogPath}.verification-state.json`, JSON.stringify({ version: 1, updatedAt: "invalid", attempts: {} }));

  await expect(runSourceVerification(candidatesPath, catalogPath)).rejects.toThrow("Invalid source verification batch state");
});
