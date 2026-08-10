import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

export function atomicJson(path: string, value: unknown): Promise<void> {
  return atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}
