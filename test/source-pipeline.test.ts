import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runSourceVerification } from "../src/source-pipeline.ts";

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
  expect(JSON.parse(await readFile(catalogPath, "utf8")).acme.name).toBe("Acme");
});
