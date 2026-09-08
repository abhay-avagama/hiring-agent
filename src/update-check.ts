import { VERSION } from "./version.ts";

export interface UpdateNotice { installed: string; latest: string; run: string; message: string }
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const UPDATE_COMMAND = "bun add --global openings";

/**
 * One small request to the npm registry at startup, never blocking a tool call. The result rides on every tool
 * response so the AI app can prompt the person to update; the server itself never modifies the install.
 */
export function startUpdateCheck(options: { current?: string; fetcher?: Fetch; timeoutMs?: number; enabled?: boolean } = {}): { get(): UpdateNotice | null; ready: Promise<void> } {
  const current = options.current ?? VERSION;
  let notice: UpdateNotice | null = null;
  const ready = options.enabled === false ? Promise.resolve() : (async () => {
    try {
      const response = await (options.fetcher ?? globalThis.fetch)("https://registry.npmjs.org/openings/latest", { signal: AbortSignal.timeout(options.timeoutMs ?? 5_000), headers: { accept: "application/json" } });
      if (!response.ok) return;
      const body = await response.json() as { version?: unknown };
      if (typeof body.version === "string" && isNewer(body.version, current)) notice = updateNotice(current, body.version);
    } catch { /* offline or blocked: no notice */ }
  })();
  return { get: () => notice, ready };
}

export function updateNotice(installed: string, latest: string): UpdateNotice {
  return { installed, latest, run: UPDATE_COMMAND, message: `Openings ${latest} is available; ${installed} is installed. Tell the person to run "${UPDATE_COMMAND}" and restart their AI app to get fixes and new coverage.` };
}

/** Numeric dot-version comparison; pre-release suffixes are ignored. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parse(candidate), parse(current)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}
