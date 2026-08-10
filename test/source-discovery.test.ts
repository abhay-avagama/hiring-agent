import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runSourceDiscovery, runYcSourceDiscovery } from "../src/source-discovery.ts";
import { discoverAndPromote } from "../src/source-discovery-pipeline.ts";

test("static discovery feeds enrich Greenhouse sources without guessing missing company domains", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-discovery-"));
  const feedPath = join(directory, "feed.json");
  const candidatesPath = join(directory, "candidates.json");
  const reportPath = join(directory, "report.json");
  await writeFile(candidatesPath, JSON.stringify([
    { companyName: "Existing", companyDomain: "existing.test", sourceUrl: "https://job-boards.greenhouse.io/existing", discoveredFrom: { channel: "legacy", reference: "seed" } },
  ]));
  await writeFile(feedPath, JSON.stringify([
    { sourceUrl: "https://job-boards.greenhouse.io/acme/jobs/123", companyDomain: "acme.test", channel: "community", reference: "issue 1", domainEvidence: "company_registry" },
    { sourceUrl: "https://boards.greenhouse.io/acme", companyDomain: "acme.test", reference: "duplicate row" },
    { sourceUrl: "https://job-boards.greenhouse.io/nodomain", reference: "dataset row 3" },
    { sourceUrl: "https://example.test/jobs", companyDomain: "bad.test", reference: "dataset row 4" },
  ]));

  const report = await runSourceDiscovery(feedPath, candidatesPath, reportPath, {
    country: "IN",
    fetch: async (input) => {
      const token = new URL(String(input)).pathname.split("/")[3];
      return Response.json({ jobs: [{ company_name: token === "acme" ? "Acme" : "No Domain" }] });
    },
  });

  const candidates = JSON.parse(await readFile(candidatesPath, "utf8"));
  expect(candidates).toHaveLength(2);
  expect(candidates[1]).toEqual(expect.objectContaining({
    companyName: "Acme", companyDomain: "acme.test", sourceUrl: "https://job-boards.greenhouse.io/acme",
    cohorts: ["IN"], discoveredFrom: { channel: "community", reference: "issue 1" },
    domainEvidence: { kind: "company_registry", reference: "issue 1" },
  }));
  expect(report).toEqual(expect.objectContaining({ discovered: 4, ready: 1, needsDomain: 1, rejected: 2 }));
  expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);
});

test("discovery automatically promotes the expanded candidate set into the verified catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-discovery-promotion-"));
  const feedPath = join(directory, "feed.json");
  const candidatesPath = join(directory, "candidates.json");
  const reportPath = join(directory, "report.json");
  const catalogPath = join(directory, "companies.json");
  await writeFile(feedPath, JSON.stringify([{
    sourceUrl: "https://job-boards.greenhouse.io/acme", companyDomain: "acme.test", domainEvidence: "company_registry", reference: "registry row",
  }]));
  const fetcher = async () => Response.json({ jobs: [{ id: 1, company_name: "Acme", title: "Engineer", location: { name: "India" }, absolute_url: "https://job-boards.greenhouse.io/acme/jobs/1" }] });

  const result = await discoverAndPromote(
    () => runSourceDiscovery(feedPath, candidatesPath, reportPath, { fetch: fetcher }),
    candidatesPath, catalogPath, { fetch: fetcher },
  );

  expect(result.promotion).toEqual(expect.objectContaining({ verified: 1, rejected: 0 }));
  expect(JSON.parse(await readFile(catalogPath, "utf8")).acme.name).toBe("Acme");
});

test("YC discovery creates country-focused Greenhouse seeds from the keyless company API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-yc-discovery-"));
  const candidatesPath = join(directory, "candidates.json");
  const reportPath = join(directory, "report.json");
  const report = await runYcSourceDiscovery(candidatesPath, reportPath, {
    country: "IN",
    fetch: async (input) => {
      if (String(input).includes("yc-oss")) return Response.json([
        { name: "Acme", slug: "acme", website: "https://acme.test", all_locations: "Bengaluru, India" },
        { name: "Elsewhere", slug: "elsewhere", website: "https://elsewhere.test", all_locations: "Paris, France" },
      ]);
      return Response.json({ jobs: [{ company_name: "Acme" }] });
    },
  });

  expect(report).toEqual(expect.objectContaining({ discovered: 1, ready: 1, rejected: 0 }));
  expect(JSON.parse(await readFile(candidatesPath, "utf8"))[0]).toEqual(expect.objectContaining({
    companyName: "Acme", companyDomain: "acme.test", cohorts: ["IN"],
    discoveredFrom: { channel: "dataset", reference: "https://www.ycombinator.com/companies/acme" },
  }));
});

test("concurrent discovery campaigns merge candidates without lost updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-concurrent-discovery-"));
  const candidatesPath = join(directory, "candidates.json");
  const feeds = ["alpha", "beta"];
  await Promise.all(feeds.map(async (name) => {
    const feedPath = join(directory, `${name}.json`);
    await writeFile(feedPath, JSON.stringify([{
      sourceUrl: `https://job-boards.greenhouse.io/${name}`, companyDomain: `${name}.test`, domainEvidence: "company_registry", reference: `${name} registry`,
    }]));
    await runSourceDiscovery(feedPath, candidatesPath, join(directory, `${name}-report.json`), {
      fetch: async () => Response.json({ jobs: [{ company_name: name }] }),
    });
  }));

  expect(JSON.parse(await readFile(candidatesPath, "utf8")).map((candidate: { companyName: string }) => candidate.companyName).sort()).toEqual(["alpha", "beta"]);
});
