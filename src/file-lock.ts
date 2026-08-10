import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      try { return await operation(); }
      finally { await handle.close(); await unlink(lockPath).catch(() => undefined); }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST") || Date.now() >= deadline) throw error;
      if (await lockIsStale(lockPath)) { await unlink(lockPath).catch(() => undefined); continue; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function lockIsStale(path: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value === "object" && value !== null && "pid" in value && typeof value.pid === "number") {
      try { process.kill(value.pid, 0); return false; }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return true; }
    }
    return Date.now() - (await stat(path)).mtimeMs > 60_000;
  } catch { return false; }
}
