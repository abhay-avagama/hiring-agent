import { parseCandidateProfile, type CandidateProfile, type ResumeInput } from "./candidate-profile.ts";
import type { SnapshotStore } from "./crawler.ts";
import { matchJobs, type CandidateIntent, type FilteredJob, type JobMatch } from "./job-matching.ts";
import { isEligibleForCountry } from "./locations.ts";
import type { Company, CrawlReport, JobSnapshot } from "./types.ts";
import { snapshotStatus, type CrawlScope, type SnapshotStatus } from "./local-jobs.ts";
import { assertKnownKeys, isRecord, validateCandidateIntent } from "./intent-validation.ts";

export type RefreshPolicy = "auto" | "never" | "always";
export interface RecommendationRefreshInput { policy?: RefreshPolicy; minimumMatches?: number; staleDays?: number }
export interface RecommendJobsInput { resume: ResumeInput; intent: CandidateIntent; refresh?: RecommendationRefreshInput; limit?: number }
export interface RecommendationRefreshResult {
  policy: RefreshPolicy;
  attempted: boolean;
  occurred: boolean;
  reason: "policy_never" | "policy_always" | "snapshot_missing" | "snapshot_stale" | "insufficient_matches" | "not_needed";
  failures: CrawlReport["failed"];
  error?: { code: "refresh_failed"; message: string };
}
export interface RecommendJobsResult {
  profile: CandidateProfile;
  matches: JobMatch[];
  filteredOut: FilteredJob[];
  assumptions: string[];
  snapshot: SnapshotStatus;
  refresh: RecommendationRefreshResult;
  shortfall?: { minimumMatches: number; actualMatches: number; message: string };
  nextActions: string[];
}

export interface JobRecommenderOptions {
  sources: Company[];
  store: SnapshotStore;
  crawl(scope?: CrawlScope): Promise<CrawlReport>;
  now?: () => Date;
}

export class RecommendationError extends Error {
  constructor(readonly code: "snapshot_unavailable" | "invalid_recommendation_input", message: string, readonly field?: string) { super(message); }
}

export function createJobRecommender(options: JobRecommenderOptions) {
  const now = options.now ?? (() => new Date());
  return {
    async recommend(value: unknown): Promise<RecommendJobsResult> {
      const input = validateRecommendationInput(value);
      const policy = input.refresh?.policy ?? "auto";
      const staleDays = input.refresh?.staleDays ?? 14;
      const minimumMatches = input.refresh?.minimumMatches ?? 5;
      const profile = parseCandidateProfile(input.resume);
      let snapshot = await options.store.read();
      const fallbackSnapshot = snapshot;
      const fallbackRevision = snapshotRevision(snapshot);
      let matching = snapshot ? matchSnapshot(profile, input.intent, snapshot) : undefined;
      const fallbackMatching = matching;
      const relevant = snapshot ? relevantSnapshot(snapshot, input.intent, options.sources) : null;
      const reason = refreshReason(policy, relevant, matching?.matches.length ?? 0, minimumMatches, staleDays, now());
      let report: CrawlReport | undefined;
      let refreshError: RecommendationRefreshResult["error"];
      const attempted = reason !== "policy_never" && reason !== "not_needed";
      if (reason !== "policy_never" && reason !== "not_needed") {
        try {
          report = await options.crawl(refreshScope(input.intent, fallbackSnapshot, options.sources));
          const refreshedSnapshot = await options.store.read();
          if (!refreshedSnapshot) throw new Error("Refresh completed without producing a snapshot");
          snapshot = refreshedSnapshot;
          matching = matchSnapshot(profile, input.intent, snapshot);
        } catch (error) {
          refreshError = { code: "refresh_failed", message: error instanceof Error ? error.message : String(error) };
          try {
            snapshot = await options.store.read() ?? fallbackSnapshot;
            matching = snapshot ? matchSnapshot(profile, input.intent, snapshot) : fallbackMatching;
          } catch {
            snapshot = fallbackSnapshot;
            matching = fallbackMatching;
          }
        }
      }
      if (!snapshot || !matching) throw new RecommendationError("snapshot_unavailable", "No local job snapshot is available");
      const shortfall = matching.matches.length < minimumMatches ? {
        minimumMatches,
        actualMatches: matching.matches.length,
        message: `Found ${matching.matches.length} qualifying jobs after applying the requested constraints; ${minimumMatches} were requested`,
      } : undefined;
      const limited = limitMatching(matching, input.limit);
      const applied = snapshotRevision(snapshot) !== fallbackRevision;
      const occurred = report ? report.succeeded > 0 : applied;
      return {
        profile,
        ...limited,
        snapshot: snapshotStatus(relevantSnapshot(snapshot, input.intent, options.sources), staleDays, now(), occurred && applied),
        refresh: { policy, attempted, occurred, reason, failures: report?.failed ?? [], ...(refreshError ? { error: refreshError } : {}) },
        ...(shortfall ? { shortfall } : {}),
        nextActions: limited.matches.length ? [`Analyze fit for job ${limited.matches[0]!.job.id}`] : ["Clarify or broaden explicit job intent"],
      };
    },
  };
}

function validateRecommendationInput(value: unknown): RecommendJobsInput {
  if (!isRecord(value)) throw invalidInput("input", "Recommendation input must be an object");
  assertKnownKeys(value, ["resume", "intent", "refresh", "limit"], "input", invalidInput);
  if (!isRecord(value.resume)) throw invalidInput("resume", "Resume input must be an object");
  assertKnownKeys(value.resume, ["content", "format"], "resume", invalidInput);
  validateCandidateIntent(value.intent, invalidInput);
  if (value.refresh !== undefined) {
    if (!isRecord(value.refresh)) throw invalidInput("refresh", "Refresh settings must be an object");
    assertKnownKeys(value.refresh, ["policy", "minimumMatches", "staleDays"], "refresh", invalidInput);
    if (value.refresh.policy !== undefined && !["auto", "never", "always"].includes(value.refresh.policy as string)) throw invalidInput("refresh.policy", "Unknown refresh policy");
    validateNonNegativeInteger(value.refresh.minimumMatches, "refresh.minimumMatches");
    validateNonNegativeFinite(value.refresh.staleDays, "refresh.staleDays");
  }
  if (value.limit !== undefined && (!Number.isInteger(value.limit) || (value.limit as number) <= 0 || (value.limit as number) > 100)) throw invalidInput("limit", "limit must be an integer between 1 and 100");
  return value as unknown as RecommendJobsInput;
}

function validateNonNegativeFinite(value: unknown, field: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw invalidInput(field, `${field} must be a non-negative finite number`);
}

function validateNonNegativeInteger(value: unknown, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) throw invalidInput(field, `${field} must be a non-negative integer`);
}

function invalidInput(field: string, message: string): RecommendationError {
  return new RecommendationError("invalid_recommendation_input", message, field);
}

function matchSnapshot(profile: CandidateProfile, intent: CandidateIntent, snapshot: JobSnapshot) {
  const jobs = Object.values(snapshot.partitions).flatMap((partition) => partition.jobs);
  return matchJobs(profile, intent, jobs, jobs.length);
}

function limitMatching<T extends ReturnType<typeof matchSnapshot>>(matching: T, limit = 20): T {
  return { ...matching, matches: matching.matches.slice(0, Math.max(0, limit)) };
}

function refreshReason(policy: RefreshPolicy, snapshot: JobSnapshot | null, matchCount: number, minimumMatches: number, staleDays: number, now: Date): RecommendationRefreshResult["reason"] {
  if (policy === "never") return "policy_never";
  if (policy === "always") return "policy_always";
  if (!snapshot) return "snapshot_missing";
  if (snapshotStatus(snapshot, staleDays, now, false).stale) return "snapshot_stale";
  if (matchCount < minimumMatches) return "insufficient_matches";
  return "not_needed";
}

function refreshScope(intent: CandidateIntent, snapshot: JobSnapshot | null, sources: Company[]): CrawlScope {
  return intent.countries?.length ? { slugs: relevantSourceSlugs(snapshot, intent, sources) } : {};
}

function relevantSnapshot(snapshot: JobSnapshot, intent: CandidateIntent, sources: Company[]): JobSnapshot {
  if (!intent.countries?.length) return snapshot;
  const relevantSlugs = new Set(relevantSourceSlugs(snapshot, intent, sources));
  return { ...snapshot, partitions: Object.fromEntries(Object.entries(snapshot.partitions).filter(([slug]) => relevantSlugs.has(slug))) };
}

function relevantSourceSlugs(snapshot: JobSnapshot | null, intent: CandidateIntent, sources: Company[]): string[] {
  const countries = [...new Set((intent.countries ?? []).map((country) => country.toUpperCase()))];
  const available = new Set(sources.map((source) => source.slug));
  const relevant = new Set(sources.filter((source) => source.cohorts?.some((country) => countries.includes(country))).map((source) => source.slug));
  for (const [slug, partition] of Object.entries(snapshot?.partitions ?? {})) {
    if (available.has(slug) && partition.jobs.some((job) => countries.some((country) => isEligibleForCountry(job, country)))) relevant.add(slug);
  }
  return sources.map((source) => source.slug).filter((slug) => relevant.has(slug));
}

function snapshotRevision(snapshot: JobSnapshot | null): string {
  if (!snapshot) return "missing";
  return JSON.stringify([snapshot.updatedAt, Object.entries(snapshot.partitions).map(([slug, partition]) => [slug, partition.fetchedAt])]);
}
