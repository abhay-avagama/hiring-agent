import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certificateNames, discoverCareerSubdomains } from "../src/subdomain-discovery.ts";

test("careers subdomains come from certificate logs and conventional names, only when they resolve", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subdomains-"));
  const seeds = join(dir, "seeds.json"); const output = join(dir, "career-seeds.json");
  await writeFile(seeds, JSON.stringify([{ companyName: "Acme", companyDomain: "www.acme.test" }, { companyName: "Bad", companyDomain: "not a domain" }]));
  const requested: string[] = [];
  const report = await discoverCareerSubdomains(seeds, output, {
    delayMs: 0,
    fetch: (async (input: string | URL) => { requested.push(String(input)); return Response.json([{ name_value: "*.acme.test\nwork-with-us.acme.test" }, { name_value: "mail.acme.test" }, { name_value: "talent-portal.acme.test" }, { name_value: "acme.test" }]); }) as unknown as typeof fetch,
    resolve: async (host) => ["careers.acme.test", "work-with-us.acme.test"].includes(host) ? ["203.0.113.5"] : [],
  });
  expect(requested).toEqual(["https://crt.sh/?q=%25.acme.test&output=json"]);
  expect(report.failures).toEqual([{ companyDomain: "not a domain", reason: "invalid_domain", detail: "companyDomain must be a hostname" }]);
  expect(report.seeds.map((seed) => [seed.careerUrl, seed.via])).toEqual([["https://careers.acme.test/", "conventional_name"], ["https://work-with-us.acme.test/", "certificate_transparency"]]);
  expect(JSON.parse(await readFile(output, "utf8"))).toEqual([{ companyName: "Acme", companyDomain: "acme.test", careerUrl: "https://careers.acme.test/" }, { companyName: "Acme", companyDomain: "acme.test", careerUrl: "https://work-with-us.acme.test/" }]);
});

test("certificate names are normalised and scoped to the domain", async () => {
  const names = await certificateNames("acme.test", (async () => Response.json([{ name_value: "*.Jobs.acme.test\nother.example" }, { name_value: "jobs.acme.test" }])) as unknown as typeof fetch);
  expect(names).toEqual(["jobs.acme.test"]);
});
