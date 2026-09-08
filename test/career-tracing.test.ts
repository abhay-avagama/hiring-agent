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
    headTransport: async (url) => {
      const response = new Response("<html>must not be read</html>");
      const originalText = response.text.bind(response);
      response.text = async () => { bodyRead = true; return originalText(); };
      return url.hostname === "acme.test" ? new Response(null, { status: 302, headers: { location: "https://job-boards.greenhouse.io/acme" } }) : response;
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
    country: "IN", searchKey: "secret", registryPath: join(directory, "leads.json"),
    fetch: async (input, init) => {
      if (String(input).includes("api.search.brave.com")) {
        searchAuthenticated = new Headers(init?.headers).get("X-Subscription-Token") === "secret";
        return Response.json({ web: { results: [{ url: "https://jobs.ashbyhq.com/acme/role" }] } });
      }
      return new Response(null, { status: 200 });
    },
  });

  expect(report).toEqual(expect.objectContaining({ ready: 0, matched: 1, unresolved: 0, rejected: 0, registryAdded: 1 }));
  expect(searchAuthenticated).toBeTrue();
  expect(JSON.parse(await readFile(join(directory, "leads.json"), "utf8")).leads[0].discoveredFrom[0].channel).toBe("search");
});

test("career tracing joins company identities to durable Common Crawl ATS leads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-careers-leads-"));
  const inputPath = join(directory, "companies.json");
  const leadsPath = join(directory, "common-crawl.json");
  await writeFile(inputPath, JSON.stringify([{ companyName: "Acme", companyDomain: "acme.test" }]));
  await writeFile(leadsPath, JSON.stringify({ schemaVersion: 1, pipelineVersion: "common-crawl-discovery:1", generatedAt: "2026-08-10T00:00:00.000Z", leads: [{ sourceUrl: "https://job-boards.greenhouse.io/acme", token: "acme", ats: "greenhouse", discoveredFrom: { channel: "dataset", reference: "cc-index" } }] }));

  const report = await traceCareerSources(inputPath, join(directory, "candidates.json"), join(directory, "report.json"), {
    commonCrawlReportPath: leadsPath, registryPath: join(directory, "leads.json"),
    resolveHost: async () => ["93.184.216.34"],
    fetch: async () => new Response(null, { status: 200 }),
    headTransport: async () => new Response(null, { status: 200 }),
    pageTransport: async () => new Response("", { status: 404 }),
  });

  expect(report).toEqual(expect.objectContaining({ ready: 0, matched: 1, unresolved: 0, rejected: 0, registryAdded: 1 }));
  expect(JSON.parse(await readFile(join(directory, "leads.json"), "utf8")).leads[0]).toEqual(expect.objectContaining({ sourceUrl: "https://job-boards.greenhouse.io/acme" }));
});

test("career tracing refuses stale Common Crawl reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-careers-stale-report-"));
  const inputPath = join(directory, "companies.json");
  const leadsPath = join(directory, "common-crawl.json");
  await writeFile(inputPath, JSON.stringify([{ companyName: "Acme", companyDomain: "acme.test" }]));
  await writeFile(leadsPath, JSON.stringify({ leads: [] }));
  await expect(traceCareerSources(inputPath, join(directory, "candidates.json"), join(directory, "report.json"), { commonCrawlReportPath: leadsPath })).rejects.toThrow(/regenerate it with the current CLI/);
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
    headTransport: async (url) => url.hostname === "acme.test" ? new Response(null, { status: 302, headers: { location: "https://job-boards.greenhouse.io/acme" } }) : new Response(null, { status: 200 }),
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
    headTransport: async () => new Response(null, { status: 200 }),
    pageTransport: async () => new Response("", { status: 404 }),
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
    headTransport: async () => { fetched = true; return new Response(null, { status: 200 }); },
    pageTransport: async () => new Response("", { status: 404 }),
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
    headTransport: async (url) => {
      fetched.push(String(url));
      return new Response(null, { status: 302, headers: { location: "https://internal.test/admin" } });
    },
  });

  expect(fetched).toEqual(["https://acme.test/careers"]);
  expect(report.failureDetails[0]?.detail).toContain("non-public address");
});

test("career tracing admits boards linked from a company careers page within robots rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-careers-page-link-"));
  const inputPath = join(directory, "companies.json");
  await writeFile(inputPath, JSON.stringify([{ companyName: "Acme Robotics", companyDomain: "acme.test", careerUrl: "https://acme.test/careers" }]));
  const pages: Record<string, string> = {
    "/robots.txt": "User-agent: *\nDisallow: /private\n",
    "/careers": `<html><body><a href="/about">About</a><a href="https://jobs.lever.co/other-co">Partner</a><a href="https://boards.greenhouse.io/acmerobotics">Open roles</a></body></html>`,
  };
  const report = await traceCareerSources(inputPath, join(directory, "candidates.json"), join(directory, "report.json"), {
    registryPath: join(directory, "leads.json"),
    resolveHost: async () => ["93.184.216.34"],
    headTransport: async () => new Response(null, { status: 200 }),
    pageTransport: async (url) => new Response(pages[url.pathname] ?? "", { status: pages[url.pathname] ? 200 : 404 }),
  });
  expect(report).toEqual(expect.objectContaining({ ready: 1, unresolved: 0 }));
  const candidates = JSON.parse(await readFile(join(directory, "candidates.json"), "utf8"));
  expect(candidates[0]).toEqual(expect.objectContaining({ sourceUrl: "https://job-boards.greenhouse.io/acmerobotics", domainEvidence: { kind: "company_page_link", reference: "https://acme.test/careers" } }));
});

test("career tracing skips careers pages that robots.txt disallows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-careers-robots-"));
  const inputPath = join(directory, "companies.json");
  await writeFile(inputPath, JSON.stringify([{ companyName: "Acme", companyDomain: "acme.test", careerUrl: "https://acme.test/careers" }]));
  let pageFetched = false;
  const report = await traceCareerSources(inputPath, join(directory, "candidates.json"), join(directory, "report.json"), {
    registryPath: join(directory, "leads.json"),
    resolveHost: async () => ["93.184.216.34"],
    headTransport: async () => new Response(null, { status: 200 }),
    pageTransport: async (url) => {
      if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /careers\n", { status: 200 });
      pageFetched = true;
      return new Response(`<a href="https://boards.greenhouse.io/acme">Jobs</a>`, { status: 200 });
    },
  });
  expect(pageFetched).toBe(false);
  expect(report).toEqual(expect.objectContaining({ ready: 0, unresolved: 1 }));
});
