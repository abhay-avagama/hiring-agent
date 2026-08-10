import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SnapshotStore } from "./crawler.ts";
import type { JobSnapshot } from "./types.ts";

export function createFileSnapshotStore(path: string): SnapshotStore {
  return {
    async read() {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as JobSnapshot;
        if (parsed.version !== 1 || typeof parsed.partitions !== "object") {
          throw new Error(`Unsupported snapshot format: ${path}`);
        }
        return parsed;
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async write(snapshot) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, "utf8");
      await rename(temporary, path);
    },
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
