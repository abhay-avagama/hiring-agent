import { describe, expect, test } from "bun:test";
import { chunkSeeds, parseCareerPageMarkdown } from "../scripts/expand-corpus.ts";

describe("corpus expansion campaign", () => {
  test("extracts unique company-owned HTTPS career pages", () => {
    const result = parseCareerPageMarkdown(`
      <li><a href="https://www.acme.com/careers">Acme &amp; Co</a></li>
      <li><a href="https://www.acme.com/careers">Acme &amp; Co</a></li>
      <li><a href="http://unsafe.test/jobs">Unsafe</a></li>
      <li><a href="https://www.linkedin.com/company/acme">LinkedIn</a></li>
      <li><a href="https://acme.wd1.myworkdayjobs.com/jobs">Unverified ATS tenant</a></li>
    `);
    expect(result.seeds).toEqual([{ companyName: "Acme & Co", companyDomain: "acme.com", careerUrl: "https://www.acme.com/careers" }]);
    expect(result.skipped).toBe(3);
  });

  test("keeps campaign batches small and deterministic", () => {
    const seeds = Array.from({ length: 5 }, (_, index) => ({ companyName: `Company ${index}`, companyDomain: `c${index}.test`, careerUrl: `https://c${index}.test/careers` }));
    expect(chunkSeeds(seeds, 2).map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(chunkSeeds(seeds, 2)[1]![0]!.companyName).toBe("Company 2");
  });
});
