import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWatches } from "../src/local-watches.ts";
import type { CandidateProfile } from "../src/candidate-profile.ts";
import type { WatchableJob } from "../src/watch-profile.ts";

const parsed: CandidateProfile = {
  normalizedResume: { text: "PRIVATE RESUME", format: "text" } as never,
  facts: [{ id: "1", kind: "skill", value: "Kubernetes", evidence: [{ start: 0, end: 3, quote: "ran Kubernetes at Acme" }] },
          { id: "2", kind: "role", value: "Backend Engineer", evidence: [] }],
  inferences: [{ kind: "approximate_experience_years", value: 6, derivedFromFactIds: ["1"] }],
};
const job = (id: string, title: string): WatchableJob =>
  ({ id, title, company: "Acme", location: "Bengaluru, India", remote: false, countries: ["IN"], skills: "kubernetes" });

async function harness(jobs: WatchableJob[]) {
  const dir = await mkdtemp(join(tmpdir(), "watch-"));
  const notified: string[] = [];
  let live = jobs;
  const watches = createLocalWatches({
    dataDir: dir, jobs: async () => live, profileFromResume: async () => parsed,
    notify: async (t) => { notified.push(t); },
  });
  return { dir, watches, notified, setJobs: (next: WatchableJob[]) => { live = next; } };
}

test("a monitor reports only what arrived after it was made", async () => {
  const h = await harness([job("old", "Backend Engineer")]);
  const made = await h.watches.create({ resume: { content: "x", format: "text" }, intent: { countries: ["IN"] } }) as { id: string };
  // Everything live at creation counts as seen, or the first check would dump the whole index on the candidate.
  expect(((await h.watches.check({ id: made.id })) as { matches: unknown[] }).matches).toEqual([]);
  h.setJobs([job("old", "Backend Engineer"), job("new", "Senior Backend Engineer")]);
  const after = await h.watches.check({ id: made.id }) as { matches: Array<{ id: string; why: string[] }> };
  expect(after.matches.map((m) => m.id)).toEqual(["new"]);
  expect(after.matches[0]!.why.join(" ")).toContain("kubernetes");
  // And it is not reported twice.
  expect(((await h.watches.check({ id: made.id })) as { matches: unknown[] }).matches).toEqual([]);
});

test("nothing written to disk contains the resume", async () => {
  const h = await harness([job("a", "Backend Engineer")]);
  await h.watches.create({ resume: { content: "PRIVATE RESUME", format: "text" } });
  const onDisk = await Bun.file(join(h.dir, "watches.json")).text();
  expect(onDisk).not.toContain("PRIVATE RESUME");
  expect(onDisk).not.toContain("ran Kubernetes at Acme");
  expect(onDisk).toContain("kubernetes");
});

test("peek looks without consuming what it found", async () => {
  const h = await harness([job("a", "Backend Engineer")]);
  const made = await h.watches.create({ resume: { content: "x", format: "text" } }) as { id: string };
  h.setJobs([job("a", "Backend Engineer"), job("b", "Backend Engineer II")]);
  expect(((await h.watches.check({ id: made.id, peek: true })) as { matches: unknown[] }).matches.length).toBe(1);
  expect(((await h.watches.check({ id: made.id })) as { matches: unknown[] }).matches.length).toBe(1);
});

test("a sweep notifies the desktop and stopping removes everything", async () => {
  const h = await harness([job("a", "Backend Engineer")]);
  const made = await h.watches.create({ resume: { content: "x", format: "text" } }) as { id: string };
  h.setJobs([job("a", "Backend Engineer"), job("c", "Backend Engineer III")]);
  await h.watches.sweep();
  expect(h.notified[0]).toContain("1 new role");
  expect(await h.watches.stop({ id: made.id })).toMatchObject({ stopped: true });
  expect(((await h.watches.list()) as { watches: unknown[] }).watches).toEqual([]);
});
