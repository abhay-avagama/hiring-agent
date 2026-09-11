import { expect, test } from "bun:test";
import { fetchSourceJobs } from "../src/catalog.ts";
import { accenturePostedAt } from "../src/portals.ts";
import type { Company } from "../src/types.ts";

const company = (ats: Company["ats"], token: string, slug = "acme"): Company => ({ slug, name: "Acme", ats, token });

test("Accenture labels become dates and the crawl stops at the 30-day boundary with trimmed rows", async () => {
  const now = Date.parse("2026-09-11T00:00:00Z");
  expect(accenturePostedAt("Posted within last 24 hours", now)).toBe("2026-09-11T00:00:00.000Z");
  expect(accenturePostedAt("Posted 3 days ago", now)).toBe("2026-09-08T00:00:00.000Z");
  expect(accenturePostedAt("Posted 1 month ago", now)).toBe("2026-08-12T00:00:00.000Z");
  expect(accenturePostedAt("Posted more than 1 month ago", now)).toBe("2026-07-28T00:00:00.000Z");
  const pages: string[][] = [Array(100).fill("Posted 2 days ago"), Array(100).fill("Posted 1 month ago"), Array(100).fill("Posted more than 1 month ago")];
  let calls = 0;
  const fetcher = (async (_url: string, init?: RequestInit) => {
    const start = Number((init?.body as FormData).get("startIndex"));
    calls += 1;
    const labels = pages[start / 100] ?? [];
    return Response.json({ data: labels.map((label, index) => ({ requisitionId: `R${start + index}`, title: "Java Developer", location: ["Pune"], country: "India", postedDateText: label, jobDetailUrl: "https://www.accenture.com/{0}/careers/jobdetails?id=R", staticExtractiveSummary: "<p>Build services</p>", mustHaveSkills: "Java", jobDescription: "x".repeat(20_000) })) });
  }) as unknown as typeof fetch;
  const jobs = await fetchSourceJobs(company("accenture", "in-en"), fetcher);
  expect(calls).toBe(2); // the page labelled "1 month ago" is the last one read
  expect(jobs).toHaveLength(200);
  expect(jobs[0]).toEqual(expect.objectContaining({ id: "accenture:acme:R0", location: "Pune, India", eligibleCountries: ["IN"], url: "https://www.accenture.com/in-en/careers/jobdetails?id=R" }));
  expect(jobs[0]!.description).toContain("Must have skills: Java");
  expect(jobs[0]!.description.length).toBeLessThan(200);
});

test("Infosys and Capgemini normalise to India roles with the employer's own links", async () => {
  const infosys = await fetchSourceJobs(company("infosys", "41"), (async () => Response.json([{ postingId: 7, postingTitle: "Process Executive", createdOn: "2026-09-10T12:47:52.478", location: "  HYDERABAD ", country: "India", referenceCode: "PROGEN-EXTERNAL-1", sourceId: 41, rolesResponsibilities: "Handle claims", company: "Infosys BPM Limited" }])) as unknown as typeof fetch);
  expect(infosys[0]).toEqual(expect.objectContaining({ id: "infosys:acme:7", location: "Hyderabad, India", eligibleCountries: ["IN"], updatedAt: "2026-09-10T07:17:52.478Z", url: "https://career.infosys.com/jobdesc?jobReferenceCode=PROGEN-EXTERNAL-1&sourceId=41" }));
  const capgemini = await fetchSourceJobs(company("capgemini", "in-en"), (async () => Response.json({ data: [{ id: "1-en_GB_SAPBTP", ref: "1-en_GB", source: "SAP_BTP", title: "WMS Lead", location: "Bangalore", country_name: "India", updated_at: "2026-09-10T14:36:26.000Z", description_stripped: "Lead WMS rollouts" }] })) as unknown as typeof fetch);
  expect(capgemini[0]).toEqual(expect.objectContaining({ title: "WMS Lead", eligibleCountries: ["IN"], url: "https://www.capgemini.com/in-en/jobs/1-en_GB+sap_btp" }));
});

test("Amazon pages by country until its total and keeps exact posting dates", async () => {
  const pages = [Array.from({ length: 100 }, (_, i) => ({ id_icims: `A${i}`, title: "Software Dev Engineer 2", city: "Bengaluru", state: "KA", country_code: "IND", posted_date: "September 10, 2026", job_path: `/en/jobs/A${i}/sde`, description_short: "Build services", basic_qualifications: "- 3+ years", description: "x".repeat(5000) })), [{ id_icims: "B1", title: "Program Manager", city: "Hyderabad", state: "TG", country_code: "IND", posted_date: "September  7, 2026", job_path: "/en/jobs/B1/pm" }]];
  let call = 0;
  const jobs = await fetchSourceJobs(company("amazon", "IND"), (async () => Response.json({ hits: 101, jobs: pages[call++] ?? [] })) as unknown as typeof fetch);
  expect(call).toBe(2);
  expect(jobs).toHaveLength(101);
  expect(jobs[0]).toEqual(expect.objectContaining({ id: "amazon:acme:A0", location: "Bengaluru, KA, India", eligibleCountries: ["IN"], updatedAt: "2026-09-10T00:00:00.000Z", url: "https://www.amazon.jobs/en/jobs/A0/sde" }));
  expect(jobs[100]!.location).toBe("Hyderabad, TG, India"); // Telangana, not Togo
  expect(jobs[0]!.description).toContain("Basic qualifications");
});
