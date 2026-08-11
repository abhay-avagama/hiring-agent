import { expect, test } from "bun:test";
import { createSelectedJobLookup } from "../src/selected-job-lookup.ts";
import type { Job } from "../src/types.ts";

test("selected-job lookup fetches only missing structured detail and reuses complete snapshots", async () => {
  const summary = makeJob({ description: "" });
  const detail = makeJob({ description: "Java is required." });
  let detailCalls = 0;
  const lookup = createSelectedJobLookup({
    getSnapshotJob: async (id) => id === summary.id ? summary : null,
    getDetailedJob: async (id) => { detailCalls += 1; return id === detail.id ? detail : null; },
  });
  expect(await lookup(summary.id)).toEqual(detail);
  expect(detailCalls).toBe(1);

  const complete = makeJob({ id: "greenhouse:acme:2", description: "Go is required." });
  const completeLookup = createSelectedJobLookup({ getSnapshotJob: async () => complete, getDetailedJob: async () => { throw new Error("detail fetch must not run"); } });
  expect(await completeLookup(complete.id)).toEqual(complete);
});

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "workday:acme:R1", company: "Acme", title: "Backend Engineer", location: "India", remote: false, workMode: "onsite",
    eligibleCountries: ["IN"], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit", url: "https://example.test/R1", description: "", ...overrides,
  };
}
