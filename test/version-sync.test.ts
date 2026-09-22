import { expect, test } from "bun:test";
import { VERSION } from "../src/version.ts";

/**
 * The version an MCP client reads back, and the one the update check compares against npm, is a hand-written
 * constant. It drifted two releases behind, so every install on the newest package was told to update. The
 * deployment gate runs this suite, so a drift now stops the release instead of reaching people.
 */
test("the reported version matches the package", async () => {
  const pkg = await Bun.file("package.json").json() as { version: string };
  expect(VERSION).toBe(pkg.version);
});

test("the files a release stamps agree with the package", async () => {
  const pkg = await Bun.file("package.json").json() as { version: string };
  for (const path of ["server.json", "gemini-extension.json"]) {
    const value = await Bun.file(path).json() as { version: string };
    expect([path, value.version]).toEqual([path, pkg.version]);
  }
});
