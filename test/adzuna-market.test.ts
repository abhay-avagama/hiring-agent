import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { marketCoverage, sampleAdzunaMarket } from "../src/adzuna-market.ts";

test("the market map samples pages evenly within the allowance, dedupes across runs, and ages postings out after 30 days", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-market-"));
  const statePath = join(directory, "market.json");
  const pagesAsked: number[] = [];
  const day = (created: string) => async (url: string) => {
    const page = Number(/search\/(\d+)/.exec(url)?.[1]);
    pagesAsked.push(page);
    return Response.json({ count: 1000, results: Array.from({ length: 50 }, (_, index) => ({ id: `${created}-${page}-${index}`, company: { display_name: index % 2 ? "Zeta Labs Pvt Ltd" : "Acme India" }, created, location: { area: ["India", "Karnataka", "Bengaluru"] }, category: { label: "IT Jobs" } })) });
  };
  const first = await sampleAdzunaMarket("id", "key", statePath, { maxHits: 5, fetcher: day("2026-08-01T00:00:00Z"), sleep: async () => undefined, now: () => new Date("2026-08-01T12:00:00Z") });
  expect(first.hits).toBe(5);
  expect(pagesAsked).toEqual([1, 6, 11, 15, 20]); // 20 pages in the day, spread across them
  expect(first.state.employers["acme india"]?.postings).toBe(125);
  const again = await sampleAdzunaMarket("id", "key", statePath, { maxHits: 5, fetcher: day("2026-08-01T00:00:00Z"), sleep: async () => undefined, now: () => new Date("2026-08-01T13:00:00Z") });
  expect(again.newPostings).toBe(0); // same postings are never counted twice
  const later = await sampleAdzunaMarket("id", "key", statePath, { maxHits: 1, fetcher: day("2026-09-10T00:00:00Z"), sleep: async () => undefined, now: () => new Date("2026-09-10T12:00:00Z") });
  expect(later.state.employers["acme india"]?.postings).toBe(25); // August postings aged out
  const coverage = marketCoverage(later.state, { acme: { name: "Acme", token: "acme" } });
  expect(coverage).toEqual(expect.objectContaining({ employers: 2, coveredEmployers: 1, coveredPostings: 25 }));
  expect(coverage.uncovered[0]).toEqual({ name: "Zeta Labs Pvt Ltd", postings: 25, cities: ["Bengaluru"] });
});

test("short names and known aliases count as covered", () => {
  const state = { country: "in", updatedAt: "", runs: 1, hitsUsed: 1, seen: {}, employers: {
    jll: { name: "JLL", postings: 11, firstSeen: "", lastSeen: "", cities: {}, categories: {} },
    pwc: { name: "PricewaterhouseCoopers", postings: 28, firstSeen: "", lastSeen: "", cities: {}, categories: {} },
    acme: { name: "Acme", postings: 2, firstSeen: "", lastSeen: "", cities: {}, categories: {} },
  } };
  const coverage = marketCoverage(state, { jll: { name: "Jll", token: "jll.wd1.myworkdayjobs.com/jll/jllcareers" }, pwc: { name: "Pwc", token: "pwc.wd3.myworkdayjobs.com/pwc/Global_Experienced_Careers" } });
  expect(coverage.coveredEmployers).toBe(2);
  expect(coverage.uncovered.map((employer) => employer.name)).toEqual(["Acme"]);
});
