import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectJoobleSignals } from "../src/jooble-signals.ts";

test("Jooble results become employer signals with the origin site as the domain when it is company-owned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-jooble-"));
  const outputPath = join(directory, "signals.json");
  const calls: unknown[] = [];
  const fetcher = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { keywords: string; page: number };
    calls.push(body);
    if (body.page > 1) return Response.json({ totalCount: 3, jobs: [] });
    return Response.json({ totalCount: 3, jobs: [
      { id: 1, company: "NTT DATA", source: "careers-inc.nttdata.com", updated: "2026-09-02T10:00:00" },
      { id: 2, company: "Mastercard", source: "decentrajobs.com", updated: "2026-09-01T10:00:00" },
      { id: 3, company: "NTT DATA", source: "hireskys.com", updated: "2026-09-05T10:00:00" },
      { id: 1, company: "NTT DATA", source: "careers-inc.nttdata.com" },
    ] });
  };
  const report = await collectJoobleSignals("key", outputPath, { keywords: ["engineer"], fetcher, maxPages: 3 });
  expect(report.jobsSeen).toBe(3);
  expect(report.employers).toEqual([
    expect.objectContaining({ companyName: "NTT DATA", jobs: 2, newestUpdated: "2026-09-05T10:00:00", companyDomain: "nttdata.com" }),
    expect.objectContaining({ companyName: "Mastercard", jobs: 1 }),
  ]);
  expect(report.employers[1]?.companyDomain).toBeUndefined();
  expect(report.seeds).toEqual([{ companyName: "NTT DATA", companyDomain: "nttdata.com" }]);
  expect(calls).toHaveLength(1);
  expect(JSON.parse(await readFile(outputPath, "utf8")).seeds).toHaveLength(1);
});
