/**
 * Monitors that live on the candidate's own machine.
 *
 * The hosted monitor stores a derived profile on our server and emails what it finds. This one stores the same
 * profile in the user's data directory and tells their desktop instead, which means the resume, the profile and
 * the record of what has been seen never leave the machine at all. There is no account, no email address, and
 * nothing for us to lose.
 *
 * It satisfies the same interface the hosted monitors do, so the four MCP tools behave identically whether an
 * assistant is talking to a local install or to the hosted server.
 */
import { join } from "node:path";
import { atomicJson } from "./atomic-file.ts";
import { describeWatchProfile, matchWatch, toWatchProfile, type WatchableJob, type WatchProfile } from "./watch-profile.ts";
import type { CandidateProfile } from "./candidate-profile.ts";

export interface StoredWatch {
  id: string;
  label?: string;
  profile: WatchProfile;
  createdAt: string;
  lastCheckedAt?: string;
  /** Job ids already reported. Kept so a monitor says "new" and means it. */
  seen: string[];
}

interface WatchFile { version: 1; watches: StoredWatch[] }

const CAP_SEEN = 4_000;

export interface LocalWatchOptions {
  dataDir: string;
  /** Live roles to match against; the caller supplies them from whichever index it already holds. */
  jobs(): Promise<WatchableJob[]>;
  /** Parses a resume into facts. The same parser the one-off tools use. */
  profileFromResume(input: unknown): Promise<CandidateProfile>;
  notify?(title: string, body: string): Promise<void>;
  now?: () => Date;
}

export function createLocalWatches(options: LocalWatchOptions) {
  const now = options.now ?? (() => new Date());
  const path = join(options.dataDir, "watches.json");

  async function read(): Promise<WatchFile> {
    try {
      const file = await Bun.file(path).json() as WatchFile;
      return file?.version === 1 && Array.isArray(file.watches) ? file : { version: 1, watches: [] };
    } catch { return { version: 1, watches: [] }; }
  }
  const write = (file: WatchFile) => atomicJson(path, file);

  return {
    async create(input: unknown) {
      const body = (input ?? {}) as { resume?: unknown; intent?: Record<string, unknown>; label?: string };
      if (!body.resume) throw new Error("watch_jobs needs a resume to derive a profile from");
      const parsed = await options.profileFromResume({ resume: body.resume });
      const intent = (body.intent ?? {}) as { countries?: string[]; locations?: string[]; remote?: boolean; excludedTerms?: string[] };
      const profile = toWatchProfile(parsed, intent);
      const file = await read();
      const watch: StoredWatch = {
        id: `w_${now().getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        ...(body.label ? { label: String(body.label).slice(0, 60) } : {}),
        profile, createdAt: now().toISOString(), seen: [],
      };
      // Everything live counts as already seen, or the first check would report the whole index as new.
      const jobs = await options.jobs();
      const matches = matchWatch(profile, jobs, 20);
      watch.seen = matchWatch(profile, jobs, 100_000).map((m) => m.job.id).slice(0, CAP_SEEN);
      watch.lastCheckedAt = now().toISOString();
      file.watches.push(watch);
      await write(file);
      return {
        id: watch.id, holding: describeWatchProfile(profile), profile,
        matchesNow: matches.map((m) => ({ ...m.job, why: m.reasons })),
        emailing: false,
        storedAt: path,
        note: "This monitor is on your machine. The resume was read once and discarded; what is kept is the profile shown above, in a file you can open or delete.",
      };
    },

    async list() {
      const file = await read();
      return { watches: file.watches.map((w) => ({
        id: w.id, label: w.label, holding: describeWatchProfile(w.profile),
        createdAt: w.createdAt, lastCheckedAt: w.lastCheckedAt, reported: w.seen.length,
      })), storedAt: path };
    },

    async check(input: unknown) {
      const body = (input ?? {}) as { id?: string; limit?: number; peek?: boolean };
      const file = await read();
      const watch = file.watches.find((w) => w.id === body.id);
      if (!watch) throw new Error(`No monitor with id ${body.id}. Call list_watches to see them.`);
      const jobs = await options.jobs();
      const seen = new Set(watch.seen);
      const fresh = matchWatch(watch.profile, jobs, 100_000).filter((m) => !seen.has(m.job.id));
      const limited = fresh.slice(0, Math.min(body.limit ?? 20, 50));
      const checkedAt = now().toISOString();
      if (!body.peek) {
        // Everything found is marked seen, not only what was returned, or the rest would arrive again tomorrow.
        watch.seen = [...fresh.map((m) => m.job.id), ...watch.seen].slice(0, CAP_SEEN);
        watch.lastCheckedAt = checkedAt;
        await write(file);
      }
      return {
        matches: limited.map((m) => ({ ...m.job, why: m.reasons })),
        totalNew: fresh.length, checkedAt, newSince: watch.lastCheckedAt ?? watch.createdAt,
        holding: describeWatchProfile(watch.profile),
      };
    },

    async stop(input: unknown) {
      const id = ((input ?? {}) as { id?: string }).id;
      const file = await read();
      const before = file.watches.length;
      file.watches = file.watches.filter((w) => w.id !== id);
      await write(file);
      return { stopped: before !== file.watches.length,
        deleted: before !== file.watches.length ? "the monitor, its profile, and the record of what it had reported" : "nothing; no monitor had that id" };
    },

    /** Check every monitor and tell the desktop about anything new. This is what a scheduled run calls. */
    async sweep() {
      const file = await read();
      const jobs = await options.jobs();
      const results: Array<{ id: string; label?: string; found: number }> = [];
      for (const watch of file.watches) {
        const seen = new Set(watch.seen);
        const fresh = matchWatch(watch.profile, jobs, 100_000).filter((m) => !seen.has(m.job.id));
        if (fresh.length) {
          watch.seen = [...fresh.map((m) => m.job.id), ...watch.seen].slice(0, CAP_SEEN);
          const first = fresh[0]!;
          await options.notify?.(
            `${fresh.length} new role${fresh.length === 1 ? "" : "s"} for ${watch.label ?? "your monitor"}`,
            `${first.job.title} at ${first.job.company}${fresh.length > 1 ? ` and ${fresh.length - 1} more` : ""}`,
          ).catch(() => undefined);
        }
        watch.lastCheckedAt = now().toISOString();
        results.push({ id: watch.id, label: watch.label, found: fresh.length });
      }
      await write(file);
      return { checked: file.watches.length, results };
    },
  };
}
