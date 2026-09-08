import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kekaTenantCandidates } from "../src/keka-tenants.ts";

test("Keka hosts become verifiable candidates with the org id, company name, and website", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-keka-"));
  const hostsPath = join(directory, "hosts.txt");
  const outputPath = join(directory, "candidates.json");
  await writeFile(hostsPath, "scimplify.keka.com\nwww.keka.com\ndead.keka.com\nnot-a-host\n");
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://dead.")) return new Response("", { status: 404 });
    if (url.endsWith("/careers")) return new Response(`<script>fetch('/ats/documents/6E7D7968-e438-49d0-ac71-9f0487fd4395/careerportal/x.html')</script>`, { status: 200 });
    if (url.endsWith("/careerportalinfo")) return Response.json({ name: url.includes("www.") ? "" : "Scimplify", companyWebsite: "www.scimplify.com" });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const result = await kekaTenantCandidates(hostsPath, outputPath, { fetcher });
  expect(result).toEqual({ hosts: 3, candidates: 1, failed: 2 });
  expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual([expect.objectContaining({ companyName: "Scimplify", companyDomain: "scimplify.com", sourceUrl: "https://scimplify.keka.com/careers/api/embedjobs/default/active/6e7d7968-e438-49d0-ac71-9f0487fd4395", cohorts: ["IN"] })]);
});
