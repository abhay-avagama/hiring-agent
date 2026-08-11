import { expect, test } from "bun:test";

test("CLI documents its read-only commands", async () => {
  const process = Bun.spawn(["bun", "run", "src/cli.ts", "--help"], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(process.stdout).text();
  expect(await process.exited).toBe(0);
  expect(output).toContain("search");
  expect(output).toContain("get");
  expect(output).toContain("crawl");
  expect(output).toContain("snapshot export");
  expect(output).toContain("sources verify");
  expect(output).toContain("sources discover");
  expect(output).toContain("sources discover-yc");
  expect(output).toContain("sources seed-companies-yc");
  expect(output).toContain("sources discover-common-crawl");
  expect(output).toContain("sources trace-careers");
  expect(output).toContain("--country");
  expect(output).toContain("--delay-ms");
  expect(output).toContain("--offline");
  expect(output).toContain("--india");
  expect(output).not.toContain("apply");
});

test("CLI rejects an invalid crawl delay before starting network work", async () => {
  const process = Bun.spawn(["bun", "run", "src/cli.ts", "crawl", "--delay-ms", "-1"], { stdout: "pipe", stderr: "pipe" });
  const error = await new Response(process.stderr).text();
  expect(await process.exited).toBe(1);
  expect(error).toContain("--delay-ms must be an integer from 0 to 60000");
});
