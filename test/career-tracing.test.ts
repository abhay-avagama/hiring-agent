import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { traceCareerSources } from "../src/career-tracing.ts";

test("company career redirects become structured source candidates without reading HTML", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-careers-"));
  const inputPath = join(directory, "companies.json");
  const candidatesPath = join(directory, "candidates.json");
  const reportPath = join(directory, "report.json");
  await writeFile(inputPath, JSON.stringify([
    { companyName: "Acme", companyDomain: "acme.test", careerUrl: "https://acme.test/careers" },
  ]));
  let bodyRead = false;

  const report = await traceCareerSources(inputPath, candidatesPath, reportPath, {
    country: "IN",
    resolveHost: async () => ["93.184.216.34"],
    fetch: async () => {
      const response = new Response("<html>must not be read</html>");
      Object.defineProperty(response, "url", { value: "https://job-boards.greenhouse.io/acme" });
      const originalText = response.text.bind(response);
      response.text = async () => { bodyRead = true; return originalText(); };
      return response;
    },
  });

  expect(report).toEqual(expect.objectContaining({ companiesChecked: 1, ready: 1, alreadyKnown: 0, unresolved: 0, rejected: 0 }));
  expect(bodyRead).toBeFalse();
  expect(JSON.parse(await readFile(candidatesPath, "utf8"))).toEqual([
    expect.objectContaining({
      companyName: "Acme", companyDomain: "acme.test", sourceUrl: "https://job-boards.greenhouse.io/acme", cohorts: ["IN"],
      discoveredFrom: { channel: "career_page", reference: "https://acme.test/careers" },
    }),
  ]);
});

test("career tracing rejects URLs that are not owned by the declared company domain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-careers-trust-"));
  const inputPath = join(directory, "companies.json");
  await writeFile(inputPath, JSON.stringify([
    { companyName: "Acme", companyDomain: "acme.test", careerUrl: "https://attacker.test/careers" },
  ]));
  let fetched = false;

  const report = await traceCareerSources(inputPath, join(directory, "candidates.json"), join(directory, "report.json"), {
    fetch: async () => { fetched = true; return new Response(); },
  });

  expect(report).toEqual(expect.objectContaining({ ready: 0, unresolved: 0, rejected: 1 }));
  expect(report.rejections[0]?.reason).toBe("invalid_company");
  expect(fetched).toBeFalse();
});

test("an optional Brave key resolves non-redirecting career pages through ATS search results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-careers-search-"));
  const inputPath = join(directory, "companies.json");
  await writeFile(inputPath, JSON.stringify([{ companyName: "Acme", companyDomain: "acme.test" }]));
  let searchAuthenticated = false;

  const report = await traceCareerSources(inputPath, join(directory, "candidates.json"), join(directory, "report.json"), {
    country: "IN", searchKey: "secret",
    fetch: async (input, init) => {
      if (String(input).includes("api.search.brave.com")) {
        searchAuthenticated = new Headers(init?.headers).get("X-Subscription-Token") === "secret";
        return Response.json({ web: { results: [{ url: "https://jobs.ashbyhq.com/acme/role" }] } });
      }
      return new Response(null, { status: 200 });
    },
  });

  expect(report).toEqual(expect.objectContaining({ ready: 1, unresolved: 0, rejected: 0 }));
  expect(searchAuthenticated).toBeTrue();
  expect(JSON.parse(await readFile(join(directory, "candidates.json"), "utf8"))[0].discoveredFrom.channel).toBe("search");
});

test("career tracing joins company identities to durable Common Crawl ATS leads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-careers-leads-"));
  const inputPath = join(directory, "companies.json");
  const leadsPath = join(directory, "common-crawl.json");
  await writeFile(inputPath, JSON.stringify([{ companyName: "Acme", companyDomain: "acme.test" }]));
  await writeFile(leadsPath, JSON.stringify({ leads: [{ sourceUrl: "https://job-boards.greenhouse.io/acme", token: "acme", ats: "greenhouse", discoveredFrom: { channel: "dataset", reference: "cc-index" } }] }));

  const report = await traceCareerSources(inputPath, join(directory, "candidates.json"), join(directory, "report.json"), {
    commonCrawlReportPath: leadsPath,
    resolveHost: async () => ["93.184.216.34"],
    fetch: async () => new Response(null, { status: 200 }),
  });

  expect(report).toEqual(expect.objectContaining({ ready: 1, unresolved: 0, rejected: 0 }));
  expect(JSON.parse(await readFile(join(directory, "candidates.json"), "utf8"))[0]).toEqual(expect.objectContaining({
    sourceUrl: "https://job-boards.greenhouse.io/acme",
    discoveredFrom: { channel: "dataset", reference: "cc-index" },
  }));
});

test("an already-known source gains the new discovery campaign cohort", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-careers-cohort-"));
  const inputPath = join(directory, "companies.json");
  const candidatesPath = join(directory, "candidates.json");
  await writeFile(inputPath, JSON.stringify([{ companyName: "Acme", companyDomain: "acme.test", careerUrl: "https://acme.test/careers" }]));
  await writeFile(candidatesPath, JSON.stringify([{
    companyName: "Acme", companyDomain: "acme.test", sourceUrl: "https://job-boards.greenhouse.io/acme",
    discoveredFrom: { channel: "legacy", reference: "seed" },
  }]));

  const report = await traceCareerSources(inputPath, candidatesPath, join(directory, "report.json"), {
    country: "IN",
    resolveHost: async () => ["93.184.216.34"],
    fetch: async () => {
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, "url", { value: "https://job-boards.greenhouse.io/acme" });
      return response;
    },
  });

  expect(report).toEqual(expect.objectContaining({ ready: 0, alreadyKnown: 1 }));
  expect(JSON.parse(await readFile(candidatesPath, "utf8"))[0].cohorts).toEqual(["IN"]);
  expect(JSON.parse(await readFile(candidatesPath, "utf8"))[0].domainEvidence).toEqual({ kind: "company_redirect", reference: "https://acme.test/careers" });
});

test("career tracing reports optional search failures while continuing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-careers-failures-"));
  const inputPath = join(directory, "companies.json");
  await writeFile(inputPath, JSON.stringify([{ companyName: "Acme", companyDomain: "acme.test" }]));

  const report = await traceCareerSources(inputPath, join(directory, "candidates.json"), join(directory, "report.json"), {
    searchKey: "invalid",
    resolveHost: async () => ["93.184.216.34"],
    fetch: async (input) => String(input).includes("api.search.brave.com")
      ? new Response("unauthorized", { status: 401 })
      : new Response(null, { status: 200 }),
  });

  expect(report).toEqual(expect.objectContaining({ ready: 0, unresolved: 1, failures: 1 }));
  expect(report.failureDetails[0]).toEqual(expect.objectContaining({ reason: "search_failed", detail: "Brave Search returned HTTP 401" }));
});

test("career tracing blocks domains that resolve to private infrastructure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-careers-ssrf-"));
  const inputPath = join(directory, "companies.json");
  await writeFile(inputPath, JSON.stringify([{ companyName: "Metadata", companyDomain: "metadata.internal" }]));
  let fetched = false;

  const report = await traceCareerSources(inputPath, join(directory, "candidates.json"), join(directory, "report.json"), {
    resolveHost: async () => ["169.254.169.254"],
    fetch: async () => { fetched = true; return new Response(null, { status: 200 }); },
  });

  expect(fetched).toBeFalse();
  expect(report.failureDetails[0]).toEqual(expect.objectContaining({ reason: "career_request_failed", detail: expect.stringContaining("non-public address") }));
});

test("career tracing validates every redirect destination before requesting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-careers-redirect-ssrf-"));
  const inputPath = join(directory, "companies.json");
  await writeFile(inputPath, JSON.stringify([{ companyName: "Acme", companyDomain: "acme.test", careerUrl: "https://acme.test/careers" }]));
  const fetched: string[] = [];

  const report = await traceCareerSources(inputPath, join(directory, "candidates.json"), join(directory, "report.json"), {
    resolveHost: async (hostname) => hostname === "acme.test" ? ["93.184.216.34"] : ["127.0.0.1"],
    fetch: async (input) => {
      fetched.push(String(input));
      return new Response(null, { status: 302, headers: { location: "https://internal.test/admin" } });
    },
  });

  expect(fetched).toEqual(["https://acme.test/careers"]);
  expect(report.failureDetails[0]?.detail).toContain("non-public address");
});
