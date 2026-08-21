import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeJobPostingJsonLd, type ProbePage } from "../src/jobposting-probe.ts";
import { fetchSafeGet } from "../src/safe-get.ts";

test("the read-only probe discovers sitemap job pages and reports conforming company-owned JSON-LD", async () => {
  const root = await mkdtemp(join(tmpdir(), "openings-jsonld-"));
  const input = join(root, "companies.md");
  const catalog = join(root, "companies.json");
  const report = join(root, ".openings", "report.json");
  await writeFile(input, '<li><a href="https://example.com/careers">Example</a></li>\n', "utf8");
  await writeFile(catalog, "{}\n", "utf8");
  const pages = new Map<string, ProbePage>([
    ["https://example.com/robots.txt", page("text/plain", "User-agent: *\nAllow: /\nSitemap: https://example.com/jobs.xml")],
    ["https://example.com/jobs.xml", page("application/xml", '<?xml version="1.0"?><urlset><url><loc>https://example.com/careers/backend-1</loc></url></urlset>')],
    ["https://example.com/careers/backend-1", page("text/html", `<html><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org", "@type": "JobPosting", title: "Backend Engineer", description: "Build APIs.", datePosted: "2026-08-20",
      identifier: { "@type": "PropertyValue", value: "be-1" }, hiringOrganization: { "@type": "Organization", name: "Example", sameAs: "https://example.com" },
      jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressCountry: "IN" } },
    })}</script></html>`)],
  ]);

  const result = await probeJobPostingJsonLd(input, catalog, report, { reportRoot: join(root, ".openings"), fetchPage: async (url) => pages.get(url) ?? page("text/plain", "", 404), companyLimit: 10, delayMs: 0 });

  expect(result.companies).toEqual([expect.objectContaining({ companyName: "Example", companyDomain: "example.com", status: "qualified", acceptedJobs: 1 })]);
  expect(result.acceptedJobs).toBe(1);
  expect(result.identifierPresencePercent).toBe(100);
  expect(result.explicitCountryPercent).toBe(100);
  expect(JSON.parse(await readFile(report, "utf8"))).toEqual(result);
});

test("the probe rejects unsafe XML and never requests its detail URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "openings-jsonld-"));
  const input = join(root, "companies.md");
  const catalog = join(root, "companies.json");
  const requested: string[] = [];
  await writeFile(input, '<li><a href="https://careers.example.com/">Example</a></li>\n', "utf8");
  await writeFile(catalog, "{}\n", "utf8");
  const result = await probeJobPostingJsonLd(input, catalog, join(root, ".openings", "report.json"), {
    reportRoot: join(root, ".openings"),
    companyLimit: 10, delayMs: 0,
    fetchPage: async (url) => {
      requested.push(url);
      if (url.endsWith("robots.txt")) return page("text/plain", "Sitemap: https://careers.example.com/jobs.xml");
      return page("application/xml", '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><urlset><url><loc>https://example.com/jobs/1</loc></url></urlset>');
    },
  });

  expect(requested).toEqual(["https://careers.example.com/robots.txt", "https://careers.example.com/jobs.xml"]);
  expect(result.acceptedJobs).toBe(0);
  expect(result.stopReason).toBe("unsafe_xml");
  expect(result.viability).toBe("failed");
});

test("the hardened GET rejects private DNS answers before connecting", async () => {
  await expect(fetchSafeGet("https://example.com/jobs/1", { resolveHost: async () => ["127.0.0.1"] })).rejects.toThrow("non-public address");
});

test("the hardened GET timeout also bounds DNS resolution", async () => {
  await expect(fetchSafeGet("https://example.com/jobs/1", { timeoutMs: 5, resolveHost: () => new Promise(() => {}) })).rejects.toThrow("Timed out after 5ms");
});

test("listing-page markup and conflicting organization domains are never admitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "openings-jsonld-"));
  await writeFile(join(root, "companies.md"), '<li><a href="https://example.com/careers">Example</a></li>\n', "utf8");
  await writeFile(join(root, "companies.json"), "{}\n", "utf8");
  const base = { "@type": "JobPosting", title: "Engineer", description: "A complete role description", datePosted: "2026-08-20", hiringOrganization: { "@type": "Organization", name: "Example", sameAs: "https://attacker.example.net" }, jobLocation: { address: { addressCountry: "IN" } } };
  const html = `<script type="application/ld+json">${JSON.stringify([base, { ...base, title: "Engineer II" }])}</script>`;
  const result = await probeJobPostingJsonLd(join(root, "companies.md"), join(root, "companies.json"), join(root, ".openings", "report.json"), { reportRoot: join(root, ".openings"), delayMs: 0, now: new Date("2026-08-21T00:00:00.000Z"), fetchPage: async (url) => url.endsWith("robots.txt") ? page("text/plain", "Sitemap: https://example.com/jobs.xml") : url.endsWith(".xml") ? page("application/xml", "<urlset><url><loc>https://example.com/jobs/all</loc></url></urlset>") : page("text/html", html) });
  expect(result.acceptedJobs).toBe(0);
  expect(result.stopReason).toBe("multiple_jobpostings");
});

test("robots longest-match allow rules are honored and broad remote labels are not countries", async () => {
  const root = await mkdtemp(join(tmpdir(), "openings-jsonld-"));
  await writeFile(join(root, "companies.md"), '<li><a href="https://example.com/careers">Example</a></li>\n', "utf8");
  await writeFile(join(root, "companies.json"), "{}\n", "utf8");
  const requested: string[] = [];
  const remote = { "@type": "JobPosting", title: "Engineer", description: "Build systems", datePosted: "2026-08-20", identifier: { value: "1" }, hiringOrganization: { name: "Example", sameAs: "https://example.com" }, jobLocationType: "TELECOMMUTE", applicantLocationRequirements: { "@type": "Country", name: "Worldwide" } };
  const result = await probeJobPostingJsonLd(join(root, "companies.md"), join(root, "companies.json"), join(root, ".openings", "report.json"), { reportRoot: join(root, ".openings"), delayMs: 0, now: new Date("2026-08-21T00:00:00.000Z"), fetchPage: async (url) => { requested.push(url); if (url.endsWith("robots.txt")) return page("text/plain", "User-agent: *\n\nDisallow: /jobs/\nAllow: /jobs/public$\nSitemap: https://example.com/jobs.xml"); if (url.endsWith(".xml")) return page("application/xml", "<urlset><url><loc>https://example.com/jobs/private</loc></url><url><loc>https://example.com/jobs/public</loc></url></urlset>"); return page("text/html", `<script type="application/ld+json">${JSON.stringify(remote)}</script>`); } });
  expect(requested).not.toContain("https://example.com/jobs/private");
  expect(requested).toContain("https://example.com/jobs/public");
  expect(result.acceptedJobs).toBe(0);
});

test("near-miss media types are inert", async () => {
  const root = await mkdtemp(join(tmpdir(), "openings-jsonld-"));
  await writeFile(join(root, "companies.md"), '<li><a href="https://example.com/careers">Example</a></li>\n', "utf8");
  await writeFile(join(root, "companies.json"), "{}\n", "utf8");
  const requested: string[] = [];
  const result = await probeJobPostingJsonLd(join(root, "companies.md"), join(root, "companies.json"), join(root, ".openings", "report.json"), {
    reportRoot: join(root, ".openings"), delayMs: 0,
    fetchPage: async (url) => { requested.push(url); return url.endsWith("robots.txt") ? page("text/plain", "Sitemap: https://example.com/jobs.xml") : page("application/xmljunk", "<urlset><url><loc>https://example.com/jobs/1</loc></url></urlset>"); },
  });
  expect(requested).toEqual(["https://example.com/robots.txt", "https://example.com/jobs.xml"]);
  expect(result.acceptedJobs).toBe(0);
});

function page(contentType: string, body: string, status = 200): ProbePage {
  return { status, finalUrl: "", contentType, body };
}
