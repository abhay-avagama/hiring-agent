import { expect, test } from "bun:test";
import { fetchSourceJobs } from "../src/catalog.ts";
import type { Company } from "../src/types.ts";

const company: Company = { slug: "acme", name: "Acme", ats: "workday", token: "acme.wd1.myworkdayjobs.com/acme/External" };
const posting = (n: number, where: string) => ({ title: `Role ${n}`, externalPath: `/job/x/Role-${n}_R${n}`, locationsText: where, bulletFields: [`R${n}`] });
/** Workday nests the country facet under a location group; the parameter name varies by tenant. */
const countryFacets = (parameter: string, india: number, us: number) => [{ facetParameter: "locationMainGroup", descriptor: "Locations", values: [{ facetParameter: parameter, descriptor: "Country", values: [{ descriptor: "India", id: "c4f78be1a8f14da0ab49ce1162348a5e", count: india }, { descriptor: "United States of America", id: "bc33aa3152ec42d4995f4791a106ed09", count: us }, { descriptor: "Germany", id: "dcc5b7608d8644b3a93716604e78e995", count: 3 }] }] }];

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
    return Response.json({ total: 2000, jobPostings: all.slice(body.offset, body.offset + body.limit), facets: countryFacets("locationCountry", 25, 1) });
  }) as unknown as typeof fetch;
  const jobs = await fetchSourceJobs(company, fetcher, undefined, { workdayCountries: ["IN", "US"] });
  expect(jobs).toHaveLength(2000 + 24 + 1);
  expect(jobs.filter((job) => job.eligibleCountries.includes("IN"))).toHaveLength(25); // R1999 came back in the India pass, so it is labelled India too
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

test("a tenant that rejects the country facet keeps its unfiltered listing instead of failing", async () => {
  const all = Array.from({ length: 2000 }, (_, index) => posting(index, "Minneapolis, MN"));
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { offset: number; limit: number; appliedFacets: Record<string, string[]> };
    if (body.appliedFacets.locationCountry) return new Response("bad facet", { status: 400 });
    return Response.json({ total: 2000, jobPostings: all.slice(body.offset, body.offset + body.limit) });
  }) as unknown as typeof fetch;
  const jobs = await fetchSourceJobs(company, fetcher, undefined, { workdayCountries: ["IN", "US"] });
  expect(jobs).toHaveLength(2000);
});

test("multi-location postings on an uncapped tenant are labelled India from the tenant's own filter, whatever its parameter is called", async () => {
  const listing = [posting(1, "2 Locations"), posting(2, "3 Locations"), posting(3, "Pune, India"), posting(4, "2 Locations")];
  const calls: Array<Record<string, string[]>> = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { offset: number; limit: number; appliedFacets: Record<string, string[]> };
    calls.push(body.appliedFacets);
    if (body.appliedFacets.Location_Country?.[0] === "c4f78be1a8f14da0ab49ce1162348a5e") return Response.json({ total: 3, jobPostings: [listing[0], listing[1], listing[2]] });
    if (Object.keys(body.appliedFacets).length) return Response.json({ total: 4, jobPostings: listing }); // an unrecognised filter is ignored
    return Response.json({ total: 4, jobPostings: body.offset === 0 ? listing : [], facets: countryFacets("Location_Country", 3, 1) });
  }) as unknown as typeof fetch;
  const jobs = await fetchSourceJobs(company, fetcher, undefined, { workdayCountries: ["IN", "US"] });
  expect(jobs).toHaveLength(4);
  expect(jobs.filter((job) => job.eligibleCountries.includes("IN")).map((job) => job.id).sort()).toEqual(["workday:acme:R1", "workday:acme:R2", "workday:acme:R3"]);
  expect(calls.some((facets) => "Location_Country" in facets)).toBe(true);
  expect(calls.some((facets) => "locationCountry" in facets)).toBe(false); // never guesses the parameter name
});

test("a tenant that ignores the filter is detected by its total, and nothing is mislabelled", async () => {
  const listing = [posting(1, "2 Locations"), posting(2, "Austin, TX")];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { offset: number; appliedFacets: Record<string, string[]> };
    if (Object.keys(body.appliedFacets).length) return Response.json({ total: 40, jobPostings: listing }); // filter ignored, full listing
    return Response.json({ total: 2, jobPostings: body.offset === 0 ? listing : [], facets: countryFacets("locationCountry", 1, 1) });
  }) as unknown as typeof fetch;
  const jobs = await fetchSourceJobs(company, fetcher, undefined, { workdayCountries: ["IN"] });
  expect(jobs.filter((job) => job.eligibleCountries.includes("IN"))).toHaveLength(0);
});
