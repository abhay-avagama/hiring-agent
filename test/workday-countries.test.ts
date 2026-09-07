import { expect, test } from "bun:test";
import { fetchSourceJobs } from "../src/catalog.ts";
import type { Company } from "../src/types.ts";

const company: Company = { slug: "acme", name: "Acme", ats: "workday", token: "acme.wd1.myworkdayjobs.com/acme/External" };
const posting = (n: number, where: string) => ({ title: `Role ${n}`, externalPath: `/job/x/Role-${n}_R${n}`, locationsText: where, bulletFields: [`R${n}`] });

test("a capped Workday tenant gets a per-country pass and the extra roles are merged without duplicates", async () => {
  const calls: Array<{ offset: number; facets: Record<string, string[]> }> = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { offset: number; limit: number; appliedFacets: Record<string, string[]> };
    calls.push({ offset: body.offset, facets: body.appliedFacets });
    const country = body.appliedFacets.locationCountry?.[0];
    if (country === "c4f78be1a8f14da0ab49ce1162348a5e") {
      const india = [posting(1999, "Bengaluru, India"), ...Array.from({ length: 24 }, (_, i) => posting(5000 + i, "Pune, India"))];
      return Response.json({ total: india.length, jobPostings: india.slice(body.offset, body.offset + body.limit) });
    }
    if (country === "bc33aa3152ec42d4995f4791a106ed09") return Response.json({ total: 1, jobPostings: body.offset === 0 ? [posting(7000, "Austin, TX")] : [] });
    const all = Array.from({ length: 2000 }, (_, i) => posting(i, "London, United Kingdom"));
    return Response.json({ total: 2000, jobPostings: all.slice(body.offset, body.offset + body.limit) });
  }) as unknown as typeof fetch;
  const jobs = await fetchSourceJobs(company, fetcher, undefined, { workdayCountries: ["IN", "US"] });
  expect(jobs).toHaveLength(2000 + 24 + 1);
  expect(jobs.filter((job) => job.eligibleCountries.includes("IN"))).toHaveLength(24); // R1999 was already seen in the base pass and keeps its first location
  expect(new Set(jobs.map((job) => job.id)).size).toBe(2025);
  expect(calls.filter((call) => call.facets.locationCountry?.[0] === "c4f78be1a8f14da0ab49ce1162348a5e")).toHaveLength(2);
});

test("an uncapped tenant makes no country passes", async () => {
  const calls: number[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { offset: number; limit: number; appliedFacets: Record<string, string[]> };
    calls.push(Object.keys(body.appliedFacets).length);
    return Response.json({ total: 3, jobPostings: body.offset === 0 ? [posting(1, "Pune, India"), posting(2, "Austin, TX"), posting(3, "Berlin, Germany")] : [] });
  }) as unknown as typeof fetch;
  const jobs = await fetchSourceJobs(company, fetcher, undefined, { workdayCountries: ["IN", "US"] });
  expect(jobs).toHaveLength(3);
  expect(calls.every((facets) => facets === 0)).toBe(true);
});
