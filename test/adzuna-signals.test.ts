import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectAdzunaSignals } from "../src/adzuna-signals.ts";

test("Adzuna results become employer signals within a hit budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-adzuna-"));
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(url);
    const page = Number(/search\/(\d+)/.exec(url)?.[1]);
    const results = page === 1 ? Array.from({ length: 50 }, (_, index) => ({ id: `${url.includes("what=") ? "w" : "a"}${index}`, company: { display_name: index % 2 ? "Zeta Labs Pvt Ltd" : "Acme India" }, created: `2026-09-0${1 + (index % 5)}T00:00:00Z`, category: { label: "IT Jobs" }, location: { area: ["India", "Karnataka", "Bengaluru"] } })) : [{ id: "tail", company: { display_name: "Acme India" }, created: "2026-08-01T00:00:00Z" }];
    return Response.json({ count: 120, results });
  };
  const report = await collectAdzunaSignals("id", "key", join(directory, "adzuna.json"), { keywords: ["", "engineer", "sales"], fetcher, maxHits: 3, sleep: async () => undefined });
  expect(report.hits).toBe(3);
  expect(urls[0]).toContain("/jobs/in/search/1?");
  expect(urls[0]).toContain("max_days_old=30");
  expect(report.jobsSeen).toBe(101);
  expect(report.employers[0]).toEqual(expect.objectContaining({ companyName: "Acme India", jobs: 51, newestCreated: "2026-09-05T00:00:00Z", categories: ["IT Jobs"], locations: ["Bengaluru"] }));
  expect(report.employers[1]?.companyName).toBe("Zeta Labs Pvt Ltd");
});
