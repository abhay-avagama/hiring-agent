import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { withFileLock } from "../src/file-lock.ts";

test("a lock left by a dead process is reclaimed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-lock-"));
  const target = join(directory, "catalog.json");
  await writeFile(`${target}.lock`, JSON.stringify({ pid: 2_147_483_647, createdAt: "2026-01-01T00:00:00.000Z" }));
  expect(await withFileLock(target, async () => "recovered")).toBe("recovered");
});
