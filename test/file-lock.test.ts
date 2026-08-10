import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { withFileLock } from "../src/file-lock.ts";

test("a lock left by a dead process is reclaimed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-lock-"));
  const target = join(directory, "catalog.json");
  await writeFile(`${target}.lock`, JSON.stringify({ pid: 2_147_483_647, createdAt: "2026-01-01T00:00:00.000Z" }));
  expect(await withFileLock(target, async () => "recovered")).toBe("recovered");
});

test("an old truncated lock is reclaimed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-lock-"));
  const target = join(directory, "catalog.json");
  const lock = `${target}.lock`;
  await writeFile(lock, "{");
  const old = new Date(Date.now() - 120_000);
  await utimes(lock, old, old);
  expect(await withFileLock(target, async () => "recovered")).toBe("recovered");
});
