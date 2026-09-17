import { expect, test } from "bun:test";
import { classifyJob, isEligibleForCountry } from "../src/locations.ts";
import { fetchSourceJobs } from "../src/catalog.ts";
import type { Company, Job } from "../src/types.ts";

test("working with an overseas operations team does not establish applicant eligibility", () => {
  const job: Job = { id: "greenhouse:example:1", company: "Example", title: "Client Partnerships Manager", location: "Remote-US", remote: true, workMode: "remote", eligibleCountries: [], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "unknown", url: "https://example.test/jobs/1", description: "Work in tandem with our India and US Operations teams to support customers." };
  expect(isEligibleForCountry(classifyJob(job), "IN")).toBe(false);
  expect(isEligibleForCountry(classifyJob({ ...job, description: "This role is open to candidates based in India." }), "IN")).toBe(true);
  expect(isEligibleForCountry(classifyJob({ ...job, description: "You may work from anywhere in India." }), "IN")).toBe(true);
  for (const [country, code] of [["Germany", "DE"], ["Georgia", "GE"]]) {
    expect(isEligibleForCountry(classifyJob({ ...job, description: `Work in collaboration with our ${country} team.` }), code!)).toBe(false);
    expect(isEligibleForCountry(classifyJob({ ...job, description: `You may work from ${country}.` }), code!)).toBe(true);
  }
});

test("Workday employment-type bullets cannot collapse distinct jobs or transfer country eligibility", async () => {
  const company: Company = { slug: "example", name: "Example", ats: "workday", token: "example.wd1.myworkdayjobs.com/example/External" };
  const australia = { title: "Technical Project Manager", externalPath: "/job/Sydney/Technical-Project-Manager_R0022479", locationsText: "Sydney, Australia", bulletFields: ["Regular"] };
  const india = { title: "Software Engineer", externalPath: "/job/Pune/Software-Engineer_R0022480", locationsText: "2 Locations", bulletFields: ["Regular"] };
  const jobs = await fetchSourceJobs(company, async (_url, init) => {
    const filtered = Object.keys(JSON.parse(String(init?.body)).appliedFacets ?? {}).length > 0;
    return Response.json({ total: filtered ? 1 : 2, jobPostings: filtered ? [india] : [australia, india], facets: [{ facetParameter: "locationCountry", values: [{ descriptor: "India", id: "in", count: 1 }] }] });
  }, undefined, { workdayCountries: ["IN"] });
  expect(jobs).toHaveLength(2);
  expect(new Set(jobs.map((job) => job.id)).size).toBe(2);
  expect(jobs.find((job) => job.title === australia.title)?.eligibleCountries).toEqual(["AU"]);
  expect(jobs.find((job) => job.title === india.title)?.eligibleCountries).toEqual(["IN"]);
  expect(jobs.map((job) => job.id)).toEqual(["workday:example:R0022479", "workday:example:R0022480"]);
});

test("Workday keys preserve URL-corroborated requisitions and ignore changing display bullets", async () => {
  const company: Company = { slug: "example", name: "Example", ats: "workday", token: "example.wd1.myworkdayjobs.com/example/External" };
  const posting = { title: "Engineer", locationsText: "Pune, India", externalPath: "/job/Pune/Engineer_R-123-1" };
  const read = (bulletFields: string[]) => fetchSourceJobs(company, async () => Response.json({ total: 1, jobPostings: [{ ...posting, bulletFields }] }));
  expect((await read(["R-123"]))[0]?.id).toBe("workday:example:R-123");
  expect((await read(["Regular"]))[0]?.id).toBe("workday:example:R-123-1");
  expect((await read(["Full time"]))[0]?.id).toBe("workday:example:R-123-1");
  expect((await read(["R-999"]))[0]?.id).toBe("workday:example:R-123-1");
});
