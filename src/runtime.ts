import { join } from "node:path";
import type { SnapshotStore } from "./crawler.ts";
import { partitionFor, type Company, type Job, type SearchQuery } from "./types.ts";
import { fetchJobDescription, fetchSourceJobs } from "./catalog.ts";
import { createCrawlReporter, fetchSeedSnapshot, resolveAggregatorUrl } from "./crawl-reporting.ts";
import { createUsageReporter, type UsageReporter } from "./usage.ts";
import { VERSION } from "./version.ts";
import { normalizeJobExperience } from "./experience.ts";
import { catalog as liveCatalog, companies } from "./index.ts";
import { createLocalJobs } from "./local-jobs.ts";
import { createJobRecommender } from "./job-recommendations.ts";
import { createJobFitAnalyzer } from "./job-fit-analysis.ts";
import { createResumeOptimizer } from "./resume-optimization.ts";
import { createInterviewPreparer } from "./interview-preparation.ts";
import { createSelectedJobLookup } from "./selected-job-lookup.ts";
import { createFileSnapshotStore } from "./snapshot-store.ts";
import { createJobCoverageReader } from "./job-coverage.ts";
import { createJobSearchPreparer } from "./job-search-preparation.ts";

export function createRuntime(options: { dataDir?: string; concurrency?: number; crawlDelayMs?: number; workdayPageDelayMs?: number; workdayCountries?: string[]; sourceCacheHours?: number; sourceLimit?: number; timeoutMs?: number } = {}) {
  const workdayCountries = options.workdayCountries ?? (process.env.OPENINGS_WORKDAY_COUNTRIES ?? "IN,US").split(",").map((code) => code.trim().toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code));
  const dataDir = options.dataDir ?? process.env.OPENINGS_DATA_DIR ?? join(process.cwd(), ".openings");
  const store = createFileSnapshotStore(join(dataDir, "snapshot.json"));
  const aggregatorUrl = resolveAggregatorUrl(process.env.OPENINGS_AGGREGATOR_URL);
  const onCrawled = aggregatorUrl ? createCrawlReporter({ url: aggregatorUrl }) : undefined;
  const usage: UsageReporter | undefined = aggregatorUrl && (process.env.OPENINGS_USAGE ?? "on").toLowerCase() !== "off" ? createUsageReporter({ url: aggregatorUrl, dataDir, version: VERSION }) : undefined;
  const local = createLocalJobs({
    sources: companies,
    store,
    fetchJobs: (source, signal, observer) => fetchSourceJobs(source, globalThis.fetch, signal, observer),
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    sourceStartDelayMs: options.crawlDelayMs,
    sourceFreshnessMs: (options.sourceCacheHours ?? 0) * 60 * 60 * 1000,
    sourceLimit: options.sourceLimit,
    workdayPageDelayMs: options.workdayPageDelayMs,
    workdayCountries,
    // Server crawls set OPENINGS_DESCRIBE_COUNTRIES (IN) to read required experience from Workday detail pages; installs skip the extra requests.
    describe: (source, job) => fetchJobDescription(source, job, globalThis.fetch),
    describeCountries: (process.env.OPENINGS_DESCRIBE_COUNTRIES ?? "").split(",").map((code) => code.trim().toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code)),
    // The description catch-up pass raises these; unset, the nightly crawl keeps the crawler's own small defaults.
    describeLimit: positiveEnv("OPENINGS_DESCRIBE_LIMIT"),
    describeBudgetMs: positiveEnv("OPENINGS_DESCRIBE_BUDGET_MS"),
    describeMaxAgeDays: wholeEnv("OPENINGS_DESCRIBE_MAX_AGE_DAYS"),
    // Server crawls set this off: the aggregator they report to is the system of record for descriptions.
    retainDescriptions: process.env.OPENINGS_RETAIN_DESCRIPTIONS !== "off",
    onCrawled,
  });
  const recommender = createJobRecommender({ sources: companies, store, crawl: local.crawl });
  const coverage = createJobCoverageReader({ sources: companies, store });
  const preparationLocal = createLocalJobs({
    sources: companies,
    store,
    fetchJobs: (source, signal, observer) => fetchSourceJobs(source, globalThis.fetch, signal, observer),
    concurrency: options.concurrency,
    timeoutMs: 90_000,
    maxAttempts: 1,
    sourceStartDelayMs: options.crawlDelayMs,
    workdayPageDelayMs: options.workdayPageDelayMs,
    workdayCountries,
    onCrawled,
  });
  const preparation = createJobSearchPreparer({ sources: companies, store, crawl: preparationLocal.crawl, seed: aggregatorUrl ? (countries) => fetchSeedSnapshot(aggregatorUrl, globalThis.fetch, 60_000, countries) : undefined });
  const getSelectedJob = createSelectedJobLookup({
    getSnapshotJob: async (id) => (await local.get(id, { offline: true, staleDays: 14 })).job,
    getDetailedJob: (id) => liveCatalog.get(id),
  });
  const analyzer = createJobFitAnalyzer({ getJob: getSelectedJob });
  const optimizer = createResumeOptimizer({ analyzeJobFit: analyzer.analyze });
  const interviews = createInterviewPreparer({ analyzeJobFit: fitFor(analyzer), employerJobs: boardJobs(store, companies) });
  return { ...local, prepareJobSearch: preparation.prepare, getJobCoverage: coverage.getCoverage, recommend: recommender.recommend, analyzeJobFit: analyzer.analyze, optimizeResume: optimizer.optimize, prepareInterview: interviews.prepare, usage };
}

/**
 * The same workflows over a read-only shared index, for the hosted connector. The store is supplied by the host
 * (the aggregator's live index), nothing is crawled, and the sources are exactly those the store holds so
 * preparation reports ready at once. No usage reporter: the host meters by account instead.
 */
export function createHostedRuntime(options: {
  sources: Company[]; store: SnapshotStore; now?: () => Date;
  /** The host's stored description for a job, when its in-memory index leaves descriptions out to save memory. */
  description?: (id: string) => string | undefined;
}) {
  const readOnly = async () => { throw new Error("The hosted index is read-only; it refreshes from the nightly crawl"); };
  const local = createLocalJobs({ sources: options.sources, store: options.store, fetchJobs: readOnly, now: options.now, sourceFreshnessMs: 0 });
  const noCrawl = async () => ({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), selected: 0, succeeded: 0, failed: [] });
  const recommender = createJobRecommender({ sources: options.sources, store: options.store, crawl: noCrawl, now: options.now });
  const coverage = createJobCoverageReader({ sources: options.sources, store: options.store });
  const preparation = createJobSearchPreparer({ sources: options.sources, store: options.store, crawl: noCrawl, now: options.now, freshnessDays: 3650 });
  // Workday and a few other boards keep descriptions off their listings, so the shared index has none: read one on demand.
  async function withDescription(job: Job | null): Promise<Job | null> {
    if (!job || job.description.trim()) return job;
    const stored = options.description?.(job.id);
    if (stored?.trim()) return normalizeJobExperience({ ...job, description: stored });
    const [ats, slug] = job.id.split(":", 3);
    const company = options.sources.find((source) => source.ats === ats && source.slug === slug);
    if (!company) return job;
    try {
      const description = await fetchJobDescription(company, job, globalThis.fetch);
      return description.trim() ? normalizeJobExperience({ ...job, description }) : job;
    } catch { return job; } // the employer's board is unreachable; the summary is still useful
  }
  const snapshotJob = async (id: string) => (await local.get(id, { offline: true, staleDays: 3650 })).job;
  const getSelectedJob = createSelectedJobLookup({ getSnapshotJob: snapshotJob, getDetailedJob: async (id) => withDescription(await snapshotJob(id)) });
  const analyzer = createJobFitAnalyzer({ getJob: getSelectedJob });
  const optimizer = createResumeOptimizer({ analyzeJobFit: analyzer.analyze });
  const interviews = createInterviewPreparer({ analyzeJobFit: fitFor(analyzer), employerJobs: boardJobs(options.store, options.sources) });
  return {
    search: (query: SearchQuery) => local.search(query, { offline: true, staleDays: 3650 }),
    get: async (id: string) => { const found = await local.get(id, { offline: true, staleDays: 3650 }); return { ...found, job: await withDescription(found.job) }; },
    prepareJobSearch: preparation.prepare, getJobCoverage: coverage.getCoverage, recommend: recommender.recommend, analyzeJobFit: analyzer.analyze, optimizeResume: optimizer.optimize, prepareInterview: interviews.prepare,
  };
}

/**
 * Every job on the board a job came from: the partition named by the source slug in its id (ats:slug:...). A pasted
 * job has no board in its id, so its employer is looked up by name; one we do not index has no jobs.
 */
function boardJobs(store: SnapshotStore, sources: Company[]) {
  const named = (value: string) => value.toLowerCase().replace(/\b(the|inc|ltd|limited|llc|pvt|private|corp|corporation|co|company|technologies|technology|solutions|systems|services|software|labs|group|global|international|india)\b|[^a-z0-9]/g, "");
  return async (job: Job): Promise<Job[]> => {
    const snapshot = await store.read();
    if (!snapshot) return [];
    const fromId = job.id.startsWith("pasted:") ? undefined : job.id.split(":", 3)[1];
    // An exact name wins; otherwise the loose name only when it picks one board, so "Access" never borrows "Access Services".
    const exact = sources.find((source) => source.name.toLowerCase() === job.company.trim().toLowerCase());
    const loose = named(job.company) ? sources.filter((source) => named(source.name) === named(job.company)) : [];
    const slug = fromId ?? exact?.slug ?? (loose.length === 1 ? loose[0]!.slug : undefined);
    return (slug && partitionFor(snapshot.partitions, slug)?.jobs) || [];
  };
}

/** Fit by id through the shared analyzer, or for a pasted job through one that knows only that job. */
function fitFor(analyzer: ReturnType<typeof createJobFitAnalyzer>) {
  return (input: unknown, pasted?: Job) => pasted ? createJobFitAnalyzer({ getJob: async () => pasted }).analyze(input) : analyzer.analyze(input);
}

/** A positive whole number from the environment, or undefined when unset or nonsense. */
function positiveEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** A whole number from the environment, zero included, or undefined when unset or nonsense. */
function wholeEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}
