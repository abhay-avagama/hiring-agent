import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

interface FileLockOptions { acquireTimeoutMs?: number; operation?: string }

export async function withFileLock<T>(path: string, operation: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const handle = await acquire(lockPath, Math.max(1, options.acquireTimeoutMs ?? configuredTimeout()));
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), operation: options.operation ?? "file update" }));
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

function configuredTimeout(): number {
  const value = Number(process.env.OPENINGS_LOCK_TIMEOUT_MS ?? 60_000);
  return Number.isFinite(value) && value > 0 ? value : 60_000;
}

async function acquire(lockPath: string, timeoutMs: number) {
  const startedAt = Date.now();
  while (true) {
    try {
      return await open(lockPath, "wx");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (await lockIsStale(lockPath)) { await unlink(lockPath).catch(() => undefined); continue; }
      if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting ${timeoutMs}ms for ${lockPath} (${await describeHolder(lockPath)})`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, timeoutMs)));
    }
  }
}

async function describeHolder(path: string): Promise<string> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null) return "holder unknown";
    const pid = "pid" in value && typeof value.pid === "number" ? `pid ${value.pid}` : "pid unknown";
    const operation = "operation" in value && typeof value.operation === "string" ? value.operation : "operation unknown";
    const createdAt = "createdAt" in value && typeof value.createdAt === "string" ? value.createdAt : "time unknown";
    return `${operation}, ${pid}, since ${createdAt}`;
  } catch { return "holder unknown"; }
}

async function lockIsStale(path: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value === "object" && value !== null && "pid" in value && typeof value.pid === "number") {
      // PID reuse can defer reclamation; it preserves mutual exclusion and is preferable to reclaiming a live writer.
      try { process.kill(value.pid, 0); return false; }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return true; }
    }
    return Date.now() - (await stat(path)).mtimeMs > 60_000;
  } catch {
    try { return Date.now() - (await stat(path)).mtimeMs > 60_000; }
    catch (error) { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
  }
}
