import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, parse, relative, resolve, sep } from "node:path";

export function openingsRootFor(path: string): string {
  const absolute = resolve(path);
  const parts = absolute.slice(parse(absolute).root.length).split(sep);
  const index = parts.indexOf(".openings");
  if (index < 0) throw new Error("Round 5 artifacts must be files under .openings");
  return resolve(parse(absolute).root, ...parts.slice(0, index + 1));
}

export async function assertArtifactFile(path: string, root = openingsRootFor(path)): Promise<void> {
  const expectedRoot = resolve(root);
  const target = resolve(path);
  const lexical = relative(expectedRoot, target);
  if (!lexical || lexical.startsWith("..") || lexical.split(sep).includes("..")) throw new Error("Round 5 artifacts must be files under .openings");

  await ensureDirectory(expectedRoot);
  const actualRoot = await realpath(expectedRoot);
  let current = expectedRoot;
  const parentParts = relative(expectedRoot, dirname(target)).split(sep).filter(Boolean);
  for (const component of parentParts) {
    current = resolve(current, component);
    await ensureDirectory(current);
    const actual = await realpath(current);
    if (relative(actualRoot, actual).startsWith("..")) throw new Error("Round 5 artifacts must be files under .openings");
  }
  try {
    const status = await lstat(target);
    if (status.isSymbolicLink()) throw new Error("Round 5 artifact files must not be symbolic links");
    if (!status.isFile()) throw new Error("Round 5 artifact target must be a regular file");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink()) throw new Error("Round 5 artifact directories must not be symbolic links");
    if (!status.isDirectory()) throw new Error("Round 5 artifact path component must be a directory");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await mkdir(path);
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("Round 5 artifact directory was replaced during creation");
  }
}
