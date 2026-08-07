import { expect, test } from "bun:test";

test("CLI documents its read-only commands", async () => {
  const process = Bun.spawn(["bun", "run", "src/cli.ts", "--help"], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(process.stdout).text();
  expect(await process.exited).toBe(0);
  expect(output).toContain("search");
  expect(output).toContain("get");
  expect(output).toContain("--india");
  expect(output).not.toContain("apply");
});
