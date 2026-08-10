import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const handle = await acquire(lockPath);
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

async function acquire(lockPath: string) {
  while (true) {
    try {
      return await open(lockPath, "wx");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (await lockIsStale(lockPath)) { await unlink(lockPath).catch(() => undefined); continue; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function lockIsStale(path: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value === "object" && value !== null && "pid" in value && typeof value.pid === "number") {
      // PID reuse can delay reclamation until the mtime fallback, but never permits concurrent writers.
      try { process.kill(value.pid, 0); return false; }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return true; }
    }
    return Date.now() - (await stat(path)).mtimeMs > 60_000;
  } catch {
    try { return Date.now() - (await stat(path)).mtimeMs > 60_000; }
    catch (error) { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
  }
}
