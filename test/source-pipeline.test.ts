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
  ]));

  const report = await runSourceVerification(candidatesPath, catalogPath, {
    fetch: async () => Response.json([{ id: "1", text: "Engineer", hostedUrl: "https://jobs.lever.co/acme/1" }]),
  });

  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  expect(Object.keys(catalog)).toEqual(["acme"]);
  expect(catalog.acme).toEqual(expect.objectContaining({ name: "Acme", ats: "lever", token: "acme" }));
  expect(report).toEqual(expect.objectContaining({ candidates: 2, verified: 1, rejected: 1 }));
  expect(report.rejections[0]).toEqual(expect.objectContaining({ companyName: "Bad", reason: "unsupported_source" }));
});
