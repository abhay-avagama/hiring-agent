import { expect, test } from "bun:test";
import { join } from "node:path";
import { access, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { forceReleaseFileLock, inspectFileLock, withFileLock } from "../src/file-lock.ts";

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

test("concurrent operations queue until the active writer finishes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-lock-"));
  const target = join(directory, "catalog.json");
  const order: string[] = [];
  const first = withFileLock(target, async () => {
    order.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 40));
    order.push("first-end");
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = withFileLock(target, async () => { order.push("second"); });

  await Promise.all([first, second]);
  expect(order).toEqual(["first-start", "first-end", "second"]);
});

test("operation errors do not orphan the lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-lock-"));
  const target = join(directory, "catalog.json");
  const error = Object.assign(new Error("operation collision"), { code: "EEXIST" });

  await expect(withFileLock(target, async () => { throw error; })).rejects.toBe(error);
  await expect(access(`${target}.lock`)).rejects.toBeDefined();
});

test("waiting for a live lock has an acquisition-only timeout with holder details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-lock-"));
  const target = join(directory, "catalog.json");
  await writeFile(`${target}.lock`, JSON.stringify({ pid: process.pid, createdAt: "2026-08-10T00:00:00.000Z", operation: "verify sources" }));

  await expect(withFileLock(target, async () => "never", { acquireTimeoutMs: 5 })).rejects.toThrow(/Timed out waiting.*verify sources.*pid/u);
});

test("operators can inspect and explicitly release a wedged lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-lock-"));
  const target = join(directory, "catalog.json");
  await writeFile(`${target}.lock`, JSON.stringify({ pid: 123, operation: "verify sources", createdAt: "2026-08-10T00:00:00.000Z" }));
  expect(await inspectFileLock(target)).toEqual(expect.objectContaining({ locked: true, pid: 123, operation: "verify sources" }));
  expect(await forceReleaseFileLock(target)).toEqual(expect.objectContaining({ locked: true, pid: 123 }));
  expect(await inspectFileLock(target)).toEqual(expect.objectContaining({ locked: false }));
});
