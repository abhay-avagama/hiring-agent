import { readFile } from "node:fs/promises";
import { atomicJson } from "./atomic-file.ts";
import { providerSpec } from "./providers.ts";
import type { SourceCandidate } from "./types.ts";

/**
 * Keka tenants are discoverable by host, but a board token needs the org id that only the careers portal shell carries.
 * One fetch per tenant turns a host list into verifiable candidates with the company name and, when Keka exposes it,
 * the company's own website as the domain to verify against.
 */
export async function kekaTenantCandidates(hostsPath: string, outputPath: string, options: { fetcher?: typeof fetch; concurrency?: number; timeoutMs?: number } = {}): Promise<{ hosts: number; candidates: number; failed: number }> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const hosts = [...new Set((await readFile(hostsPath, "utf8")).split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter((line) => /^[a-z0-9-]+\.keka\.com$/.test(line)))];
  const spec = providerSpec("keka")!;
  const candidates: SourceCandidate[] = [];
  let failed = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < hosts.length) {
      const host = hosts[cursor++]!;
      const tenant = host.split(".")[0]!;
      try {
        const get = async (url: string, format: "json" | "text" = "json") => { const reply = await fetcher(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 15_000), headers: { accept: format === "text" ? "text/html" : "application/json" } }); if (!reply.ok) throw new Error(`HTTP ${reply.status}`); return format === "text" ? reply.text() : reply.json(); };
        const shell = await get(`https://${host}/careers`, "text") as string;
        const org = /\/ats\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i.exec(shell)?.[1]?.toLowerCase();
        if (!org) { failed += 1; continue; }
        const info = await spec.companyInfo!(`${tenant}/${org}`, get);
        if (!info.name) { failed += 1; continue; }
        candidates.push({
          companyName: info.name, companyDomain: info.website ?? host, sourceUrl: spec.endpoint(`${tenant}/${org}`), cohorts: ["IN"],
          discoveredFrom: { channel: "provider_directory", reference: `https://${host}/careers` },
        });
      } catch { failed += 1; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 6) }, worker));
  await atomicJson(outputPath, candidates);
  return { hosts: hosts.length, candidates: candidates.length, failed };
}
