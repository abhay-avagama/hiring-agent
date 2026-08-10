import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateYcCompanySeeds } from "../src/company-seeds.ts";

test("YC company seed generation creates a country-focused deduplicated domain file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-company-seeds-"));
  const outputPath = join(directory, "company-domains.json");
  const report = await generateYcCompanySeeds(outputPath, {
    country: "IN",
    fetch: async () => Response.json([
      { name: "Acme", website: "https://www.acme.test", all_locations: "Bengaluru, India" },
      { name: "Acme Duplicate", website: "https://acme.test/about", all_locations: "India" },
      { name: "Elsewhere", website: "https://elsewhere.test", all_locations: "Paris, France" },
      { name: "Broken", website: "not a url", all_locations: "India" },
    ]),
  });

  expect(report).toEqual({ country: "IN", matched: 3, written: 1, skipped: 2, outputPath });
  expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual([
    { companyName: "Acme", companyDomain: "acme.test" },
  ]);
});
