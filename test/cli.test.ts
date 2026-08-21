import { expect, test } from "bun:test";

test("CLI documents its read-only commands", async () => {
  const process = Bun.spawn(["bun", "run", "src/cli.ts", "--help"], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(process.stdout).text();
  expect(await process.exited).toBe(0);
  expect(output).toContain("search");
  expect(output).toContain("get");
  expect(output).toContain("crawl");
  expect(output).toContain("snapshot export");
  expect(output).toContain("coverage report");
  expect(output).toContain("sources verify");
  expect(output).toContain("sources discover");
  expect(output).toContain("sources discover-yc");
  expect(output).toContain("sources seed-companies-yc");
  expect(output).toContain("sources discover-common-crawl");
  expect(output).toContain("sources trace-careers");
  expect(output).toContain("sources probe-jobposting");
  expect(output).toContain("--country");
  expect(output).toContain("--delay-ms");
  expect(output).toContain("--source-cache-hours");
  expect(output).toContain("--source-limit");
  expect(output).toContain("--offline");
  expect(output).toContain("--india");
  expect(output).not.toContain("apply");
});

test("CLI enforces the approved JobPosting probe phase caps before network work", async () => {
  const process = Bun.spawn(["bun", "run", "src/cli.ts", "sources", "probe-jobposting", "data/companies-career-page.md", "--company-limit", "11"], { stdout: "pipe", stderr: "pipe" });
  expect(await process.exited).toBe(1);
  expect(await new Response(process.stderr).text()).toContain("--company-limit must be 10 or 20");

  const unsafeReport = Bun.spawn(["bun", "run", "src/cli.ts", "sources", "probe-jobposting", "data/companies-career-page.md", "--report", "data/companies.json"], { stdout: "pipe", stderr: "pipe" });
  expect(await unsafeReport.exited).toBe(1);
  expect(await new Response(unsafeReport.stderr).text()).toContain("must be a file under .openings");
});

test("CLI rejects invalid coverage controls before reading report inputs", async () => {
  const missingCountry = Bun.spawn(["bun", "run", "src/cli.ts", "coverage", "report"], { stdout: "pipe", stderr: "pipe" });
  expect(await missingCountry.exited).toBe(1);
  expect(await new Response(missingCountry.stderr).text()).toContain("coverage report requires --country CODE");

  const invalidTime = Bun.spawn(["bun", "run", "src/cli.ts", "coverage", "report", "--country", "IN", "--as-of", "invalid"], { stdout: "pipe", stderr: "pipe" });
  expect(await invalidTime.exited).toBe(1);
  expect(await new Response(invalidTime.stderr).text()).toContain("--as-of requires a canonical ISO timestamp");

  const ambiguousTime = Bun.spawn(["bun", "run", "src/cli.ts", "coverage", "report", "--country", "IN", "--as-of", "2026-08-19"], { stdout: "pipe", stderr: "pipe" });
  expect(await ambiguousTime.exited).toBe(1);
  expect(await new Response(ambiguousTime.stderr).text()).toContain("--as-of requires a canonical ISO timestamp");
});

test("CLI rejects an invalid crawl delay before starting network work", async () => {
  const process = Bun.spawn(["bun", "run", "src/cli.ts", "crawl", "--delay-ms", "-1"], { stdout: "pipe", stderr: "pipe" });
  const error = await new Response(process.stderr).text();
  expect(await process.exited).toBe(1);
  expect(error).toContain("--delay-ms must be an integer from 0 to 60000");
});
