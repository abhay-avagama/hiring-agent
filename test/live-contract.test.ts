import { expect, test } from "bun:test";
import { createCatalog } from "../src/catalog.ts";
import type { Ats } from "../src/types.ts";

const enabled = process.env.OPENINGS_LIVE_TESTS === "1";
const boards: Array<{ slug: string; name: string; ats: Ats; token: string }> = [
  { slug: "anthropic", name: "Anthropic", ats: "greenhouse", token: "anthropic" },
  { slug: "flex", name: "Flex", ats: "lever", token: "Flex" },
  { slug: "posthog", name: "PostHog", ats: "ashby", token: "posthog" },
];

for (const company of boards) {
  test.skipIf(!enabled)(`${company.ats} live contract returns searchable jobs with full descriptions`, async () => {
    const catalog = createCatalog({ companies: [company], cacheTtlMs: 0 });
    const jobs = await catalog.search({ limit: 1 });
    expect(jobs.length).toBeGreaterThan(0);
    const job = await catalog.get(jobs[0]!.id);
    expect(job?.description.trim().length).toBeGreaterThan(0);
    expect(job?.url).toStartWith("https://");
  }, 20_000);
}

test.skipIf(!enabled)("India filter returns live roles from an India-hiring board", async () => {
  const catalog = createCatalog({
    companies: [{ slug: "point72", name: "Point72", ats: "greenhouse", token: "point72" }],
    cacheTtlMs: 0,
  });
  const jobs = await catalog.search({ country: "IN", limit: 10 });
  expect(jobs.length).toBeGreaterThan(0);
  expect(jobs.every((job) => /india|bengaluru|bangalore|hyderabad|pune|chennai|mumbai|gurugram|gurgaon|noida|delhi|kolkata/i.test(job.location))).toBe(true);
}, 20_000);
