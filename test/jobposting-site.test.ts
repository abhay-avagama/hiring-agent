import { expect, test } from "bun:test";
import { crawlSite, extractJobPostings, sitePostingsToJobs } from "../src/jobposting-site.ts";

const posting = (id: string, title: string, city: string) => JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", title, identifier: { "@type": "PropertyValue", name: "req", value: id }, datePosted: "2026-09-01", hiringOrganization: { "@type": "Organization", name: "Acme" }, jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: city, addressRegion: "KA", addressCountry: "IN" } }, description: "<p>Build <b>things</b></p>", url: `https://acme.test/jobs/${id}` });

test("JobPosting JSON-LD is read from careers pages, sitemaps, and detail pages within the company's own domain", async () => {
  const pages: Record<string, string> = {
    "https://acme.test/robots.txt": "User-agent: *\nDisallow: /private\nSitemap: https://acme.test/jobs-sitemap.xml\n",
    "https://acme.test/careers": `<html><a href="/jobs/1">Engineer</a><a href="/about">About</a><a href="https://jobs.lever.co/acme">Board</a><script type="application/ld+json">{"@graph":[${posting("0", "Listed Engineer", "Bengaluru")}]}</script></html>`,
    "https://acme.test/sitemap.xml": `<urlset><url><loc>https://acme.test/jobs/2</loc></url><url><loc>https://acme.test/blog/post</loc></url></urlset>`,
    "https://acme.test/jobs-sitemap.xml": `<urlset><url><loc>https://acme.test/jobs/3</loc></url><url><loc>https://acme.test/private/jobs/4</loc></url></urlset>`,
    "https://acme.test/jobs/1": `<script type="application/ld+json">${posting("1", "Backend Engineer", "Bengaluru")}</script>`,
    "https://acme.test/jobs/2": `<script type="application/ld+json">[${posting("2", "Data Engineer", "Pune")}]</script>`,
    "https://acme.test/jobs/3": `<script type="application/ld+json">${posting("3", "Platform Engineer", "Hyderabad")}</script>`,
    "https://acme.test/private/jobs/4": `<script type="application/ld+json">${posting("4", "Hidden", "Delhi")}</script>`,
  };
  const fetched: string[] = [];
  const result = await crawlSite({ companyName: "Acme", companyDomain: "acme.test" }, {
    resolveHost: async () => ["93.184.216.34"],
    pageTransport: async (url) => { fetched.push(url.href); return new Response(pages[url.href] ?? "", { status: pages[url.href] ? 200 : 404 }); },
  });
  expect(result.careerUrl).toBe("https://acme.test/careers");
  expect(result.postings.map((entry) => entry.identifier).sort()).toEqual(["0", "1", "2", "3"]);
  expect(fetched).not.toContain("https://acme.test/private/jobs/4");
  expect(fetched).not.toContain("https://jobs.lever.co/acme");
  expect(result.postings[0]).toEqual(expect.objectContaining({ location: "Bengaluru, KA, India", company: "Acme", datePosted: "2026-09-01T00:00:00.000Z", description: "Build things" }));
  const jobs = sitePostingsToJobs({ slug: "acme", name: "Acme" }, result.postings);
  expect(jobs[0]).toEqual(expect.objectContaining({ id: "jobposting:acme:0", eligibleCountries: ["IN"], eligibilityConfidence: "explicit", updatedAt: "2026-09-01T00:00:00.000Z" }));
});

test("pages without JobPosting markup yield nothing and remote postings keep their applicant scope", () => {
  expect(extractJobPostings(`<script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>`, "https://acme.test/")).toEqual([]);
  const remote = extractJobPostings(`<script type="application/ld+json">{"@type":"JobPosting","title":"SRE","jobLocationType":"TELECOMMUTE","applicantLocationRequirements":{"@type":"Country","name":"India"}}</script>`, "https://acme.test/jobs/sre");
  expect(remote[0]).toEqual(expect.objectContaining({ title: "SRE", remote: true, location: "Remote (India)", url: "https://acme.test/jobs/sre" }));
});
