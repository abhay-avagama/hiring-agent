#!/usr/bin/env bun
import { ALL_PROVIDERS, type Ats } from "./types.ts";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { createRuntime } from "./runtime.ts";
import { atomicJson } from "./atomic-file.ts";
import { verifyBoards } from "./board-verification.ts";
import { discoverCareerSubdomains } from "./subdomain-discovery.ts";
import { runSourceVerification } from "./source-pipeline.ts";
import { runSourceDiscovery, runYcSourceDiscovery } from "./source-discovery.ts";
import { discoverAndPromote } from "./source-discovery-pipeline.ts";
import { traceCareerSources } from "./career-tracing.ts";
import { discoverCommonCrawlSources } from "./common-crawl-discovery.ts";
import { generateYcCompanySeeds } from "./company-seeds.ts";
import { exportSnapshot } from "./snapshot-export.ts";
import { enrichSourcesFromCompanies } from "./source-enrichment.ts";
import { forceReleaseFileLock, inspectFileLock } from "./file-lock.ts";
import { generateCountryCoverageReport } from "./country-coverage.ts";
import { probeJobPostingJsonLd } from "./jobposting-probe.ts";
import { probeSites } from "./site-probe.ts";
import { admitSites } from "./site-admission.ts";
import { kekaTenantCandidates } from "./keka-tenants.ts";
import { collectJoobleSignals } from "./jooble-signals.ts";
import { mergeAttemptedRoundLeads, prepareRecruiteeRoundArtifacts } from "./recruitee-round.ts";

const HELP = `Openings — search public company job boards

Usage:
  openings crawl [--workday-countries IN,US] [--country CODE | --companies FILE] [--concurrency N] [--source-cache-hours N] [--source-limit N] [--delay-ms N] [--workday-page-delay-ms N] [--timeout-ms N] [--data-dir PATH]
  openings snapshot export [--input FILE] [--output-dir PATH]
  openings coverage report --country CODE [--snapshot FILE] [--catalog FILE] [--candidates FILE] [--registry FILE] [--output FILE] [--as-of ISO]
  openings sources discover-subdomains SEEDS.json [--output FILE] [--limit N] [--delay-ms N] [--report FILE]
  openings sources verify-boards REGISTRY.json [--output FILE] [--limit N] [--concurrency N] [--report FILE]
  openings sources verify CANDIDATES.json [--output FILE] [--state-file FILE] [--concurrency N] [--workday-concurrency N] [--limit N] [--require-country CODE] [--registry FILE] [--retry-deferred]
  openings sources discover FEED.json [--country CODE] [--registry FILE] [--output FILE] [--catalog FILE] [--report FILE]
  openings sources discover-yc --country CODE [--registry FILE] [--output FILE] [--catalog FILE] [--report FILE]
  openings sources seed-companies-yc --country CODE [--output FILE]
  openings sources discover-common-crawl [--country CODE] [--provider NAME] [--index-record-limit N] [--sample-token-limit N] [--exclude-token TOKEN] [--report-only] [--registry FILE] [--output FILE] [--report FILE] [--index-url URL]
  openings sources enrich COMPANIES.json [--companies FILE]... [--evidence-kind authoritative_dataset|company_registry] [--registry FILE] [--output FILE] [--report FILE]
  openings sources trace-careers COMPANIES.json [--country CODE] [--registry FILE] [--common-crawl-report FILE] [--search-key-env NAME] [--output FILE] [--catalog FILE] [--report FILE]
  openings sources probe-jobposting COMPANIES.md [--catalog FILE] [--report FILE] [--company-limit 10|20]
  openings sources probe-sites SEEDS.json [--sample N] [--limit N] [--concurrency N] [--max-pages N] [--delay-ms N] [--report FILE]
  openings sources admit-sites REPORT.json [--catalog FILE] [--min-postings N]
  openings sources keka-tenants HOSTS.txt [--output FILE] [--registry FILE] [--concurrency N]
  openings sources jooble-signals [--location PLACE] [--max-pages N] [--output FILE]   (key from JOOBLE_API_KEY)
  openings sources prepare-recruitee-round IDENTITIES.json [--catalog FILE] [--artifacts DIR]
  openings sources merge-attempted-round-leads ISOLATED_REGISTRY [--registry FILE]
  openings search [words] [--country CODE|--india] [--location PLACE] [--remote|--onsite]
                  [--limit N] [--stale-days N] [--offline] [--data-dir PATH]
  openings get JOB_ID [--stale-days N] [--offline] [--data-dir PATH]
  openings lock inspect TARGET
  openings lock force-release TARGET --force
  openings --help

Results are JSON so humans and agents can use the same command.`;

export async function run(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }

  if (command === "get") {
    const id = rest[0];
    if (!id) return fail("get requires a JOB_ID");
    const settings = parseRuntimeOptions(rest.slice(1));
    if (typeof settings === "string") return fail(settings);
    const result = await createRuntime({ dataDir: settings.dataDir }).get(id, settings);
    if (!result.job) return fail(`Job not found: ${id}`, 2);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (command === "crawl") {
    const parsed = parseCrawl(rest);
    if (typeof parsed === "string") return fail(parsed);
    const runtime = createRuntime({
      dataDir: parsed.dataDir, concurrency: parsed.concurrency, sourceCacheHours: parsed.sourceCacheHours,
      sourceLimit: parsed.sourceLimit, crawlDelayMs: parsed.delayMs, workdayPageDelayMs: parsed.workdayPageDelayMs, workdayCountries: parsed.workdayCountries, timeoutMs: parsed.timeoutMs,
    });
    const slugs = parsed.companiesFile ? await readCompanyFile(parsed.companiesFile) : undefined;
    console.log(JSON.stringify(await runtime.crawl({ country: parsed.country, slugs }), null, 2));
    return 0;
  }

  if (command === "lock") {
    const action = rest[0];
    const target = rest[1];
    if (!target) return fail("lock requires an action and target file");
    if (action === "inspect" && rest.length === 2) { console.log(JSON.stringify(await inspectFileLock(target), null, 2)); return 0; }
    if (action === "force-release" && rest[2] === "--force" && rest.length === 3) { console.log(JSON.stringify({ released: await forceReleaseFileLock(target) }, null, 2)); return 0; }
    return fail("lock supports `inspect TARGET` or `force-release TARGET --force`");
  }

  if (command === "snapshot") {
    if (rest[0] !== "export") return fail("snapshot requires the `export` subcommand");
    const parsed = parseSnapshotExport(rest.slice(1));
    if (typeof parsed === "string") return fail(parsed);
    console.log(JSON.stringify(await exportSnapshot(parsed.input, parsed.outputDir), null, 2));
    return 0;
  }

  if (command === "coverage") {
    if (rest[0] !== "report") return fail("coverage requires the `report` subcommand");
    const parsed = parseCoverageReport(rest.slice(1));
    if (typeof parsed === "string") return fail(parsed);
    console.log(JSON.stringify(await generateCountryCoverageReport(parsed, { country: parsed.country, asOf: parsed.asOf }), null, 2));
    return 0;
  }

  if (command === "sources") {
    if (rest[0] === "prepare-recruitee-round") {
      const parsed = parsePrepareRecruiteeRound(rest.slice(1));
      if (typeof parsed === "string") return fail(parsed);
      console.log(JSON.stringify(await prepareRecruiteeRoundArtifacts(parsed.identityPath, parsed.catalog, parsed), null, 2));
      return 0;
    }
    if (rest[0] === "merge-attempted-round-leads") {
      const parsed = parseMergeAttemptedRoundLeads(rest.slice(1));
      if (typeof parsed === "string") return fail(parsed);
      console.log(JSON.stringify(await mergeAttemptedRoundLeads(parsed.isolatedRegistryPath, parsed.registry), null, 2));
      return 0;
    }
    if (rest[0] === "probe-sites") {
      const args = rest.slice(1);
      const inputPath = args[0];
      if (!inputPath || inputPath.startsWith("--")) return fail("sources probe-sites requires a seeds JSON file");
      const num = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? Number(args[index + 1]) : undefined; };
      const reportIndex = args.indexOf("--report");
      const report = await probeSites(inputPath, reportIndex >= 0 ? args[reportIndex + 1]! : ".openings/site-probe.json", { sample: num("--sample"), limit: num("--limit"), concurrency: num("--concurrency"), maxPages: num("--max-pages"), delayMs: num("--delay-ms") });
      const { sites, ...summary } = report;
      console.log(JSON.stringify({ ...summary, topSites: sites.slice(0, 15) }, null, 2));
      return 0;
    }
    if (rest[0] === "jooble-signals") {
      const args = rest.slice(1);
      const apiKey = process.env.JOOBLE_API_KEY;
      if (!apiKey) return fail("sources jooble-signals requires JOOBLE_API_KEY in the environment");
      const value = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
      const report = await collectJoobleSignals(apiKey, value("--output") ?? ".openings/jooble-signals.json", { location: value("--location"), maxPages: value("--max-pages") ? Number(value("--max-pages")) : undefined, delayMs: 500 });
      console.log(JSON.stringify({ location: report.location, queries: report.queries, jobsSeen: report.jobsSeen, employers: report.employers.length, seeds: report.seeds.length, top: report.employers.slice(0, 10) }, null, 2));
      return 0;
    }
    if (rest[0] === "keka-tenants") {
      const args = rest.slice(1);
      const hostsPath = args[0];
      if (!hostsPath || hostsPath.startsWith("--")) return fail("sources keka-tenants requires a hosts file, one tenant host per line");
      const outputIndex = args.indexOf("--output");
      const concurrencyIndex = args.indexOf("--concurrency");
      const registryIndex = args.indexOf("--registry");
      console.log(JSON.stringify(await kekaTenantCandidates(hostsPath, outputIndex >= 0 ? args[outputIndex + 1]! : "data/source-candidates.json", { concurrency: concurrencyIndex >= 0 ? Number(args[concurrencyIndex + 1]) : undefined, registryPath: registryIndex >= 0 ? args[registryIndex + 1] : undefined }), null, 2));
      return 0;
    }
    if (rest[0] === "admit-sites") {
      const args = rest.slice(1);
      const reportPath = args[0];
      if (!reportPath || reportPath.startsWith("--")) return fail("sources admit-sites requires a probe report JSON file");
      const catalogIndex = args.indexOf("--catalog");
      const minIndex = args.indexOf("--min-postings");
      console.log(JSON.stringify(await admitSites(reportPath, catalogIndex >= 0 ? args[catalogIndex + 1]! : "data/companies.json", { minPostings: minIndex >= 0 ? Number(args[minIndex + 1]) : undefined }), null, 2));
      return 0;
    }
    if (rest[0] === "probe-jobposting") {
      const parsed = parseJobPostingProbe(rest.slice(1));
      if (typeof parsed === "string") return fail(parsed);
      console.log(JSON.stringify(await probeJobPostingJsonLd(parsed.inputPath, parsed.catalog, parsed.report, { companyLimit: parsed.companyLimit }), null, 2));
      return 0;
    }
    if (rest[0] === "enrich") {
      const parsed = parseSourceEnrichment(rest.slice(1));
      if (typeof parsed === "string") return fail(parsed);
      console.log(JSON.stringify(await enrichSourcesFromCompanies(parsed.registry, parsed.companies, parsed.output, parsed.report, { evidenceKind: parsed.evidenceKind }), null, 2));
      return 0;
    }
    if (rest[0] === "seed-companies-yc") {
      const parsed = parseYcCompanySeeds(rest.slice(1));
      if (typeof parsed === "string") return fail(parsed);
      console.log(JSON.stringify(await generateYcCompanySeeds(parsed.output, parsed), null, 2));
      return 0;
    }
    if (rest[0] === "trace-careers") {
      const parsed = parseCareerTracing(rest.slice(1));
      if (typeof parsed === "string") return fail(parsed);
      const discovery = await traceCareerSources(parsed.inputPath, parsed.output, parsed.report, parsed);
      const promotion = await runSourceVerification(parsed.output, parsed.catalog, parsed);
      console.log(JSON.stringify({ discovery: compactCareerTraceReport(discovery), promotion }, null, 2));
      return 0;
    }
    if (rest[0] === "discover-common-crawl") {
      const parsed = parseCommonCrawlDiscovery(rest.slice(1));
      if (typeof parsed === "string") return fail(parsed);
      console.log(JSON.stringify(compactCommonCrawlReport(await discoverCommonCrawlSources(parsed.output, parsed.report, parsed)), null, 2));
      return 0;
    }
    if (rest[0] === "discover-yc") {
      const parsed = parseYcDiscovery(rest.slice(1));
      if (typeof parsed === "string") return fail(parsed);
      console.log(JSON.stringify(compactDiscoveryPromotion(await discoverAndPromote(
        () => runYcSourceDiscovery(parsed.output, parsed.report, parsed), parsed.output, parsed.catalog, parsed,
      )), null, 2));
      return 0;
    }
    if (rest[0] === "discover") {
      const parsed = parseSourceDiscovery(rest.slice(1));
      if (typeof parsed === "string") return fail(parsed);
      console.log(JSON.stringify(compactDiscoveryPromotion(await discoverAndPromote(
        () => runSourceDiscovery(parsed.feedPath, parsed.output, parsed.report, parsed), parsed.output, parsed.catalog, parsed,
      )), null, 2));
      return 0;
    }
    if (rest[0] === "discover-subdomains") {
      const parsed = parseDiscoverSubdomains(rest.slice(1));
      if (typeof parsed === "string") return fail(parsed);
      const report = await discoverCareerSubdomains(parsed.seeds, parsed.output, { limit: parsed.limit, delayMs: parsed.delayMs });
      if (parsed.report) await atomicJson(parsed.report, report);
      console.log(JSON.stringify({ ...report, seeds: report.seeds.length }, null, 2));
      return 0;
    }
    if (rest[0] === "verify-boards") {
      const parsed = parseVerifyBoards(rest.slice(1));
      if (typeof parsed === "string") return fail(parsed);
      const report = await verifyBoards(parsed.registry, parsed.output, { limit: parsed.limit, concurrency: parsed.concurrency });
      if (parsed.report) await atomicJson(parsed.report, report);
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    if (rest[0] !== "verify") return fail("sources requires a discovery, tracing, or `verify` subcommand");
    const parsed = parseSourceVerification(rest.slice(1));
    if (typeof parsed === "string") return fail(parsed);
    console.log(JSON.stringify(await runSourceVerification(parsed.candidatesPath, parsed.output, { concurrency: parsed.concurrency, providerConcurrency: { workday: parsed.workdayConcurrency }, limit: parsed.limit, requireCountry: parsed.requireCountry, registryPath: parsed.registryPath, retryDeferred: parsed.retryDeferred, batchStatePath: parsed.batchStatePath }), null, 2));
    return 0;
  }

  if (command === "search") {
    const parsed = parseSearch(rest);
    if (typeof parsed === "string") return fail(parsed);
    const runtime = createRuntime({ dataDir: parsed.dataDir });
    const result = await runtime.search(parsed.query, parsed);
    console.log(JSON.stringify({ jobs: result.jobs, count: result.jobs.length, snapshot: result.snapshot }, null, 2));
    return 0;
  }

  return fail(`Unknown command: ${command}`);
}

function parseJobPostingProbe(args: string[]) {
  const inputPath = args[0];
  if (!inputPath || inputPath.startsWith("--")) return "sources probe-jobposting requires a company Markdown file";
  let catalog = "data/companies.json";
  let report = ".openings/jobposting-probe-report.json";
  let companyLimit = 10;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--catalog") { catalog = args[++index] ?? ""; if (!catalog) return "--catalog requires a file"; }
    else if (arg === "--report") { report = args[++index] ?? ""; if (!report) return "--report requires a file"; }
    else if (arg === "--company-limit") { companyLimit = Number(args[++index]); if (companyLimit !== 10 && companyLimit !== 20) return "--company-limit must be 10 or 20"; }
    else return `Unknown option: ${arg}`;
  }
  return { inputPath, catalog, report, companyLimit };
}

function parsePrepareRecruiteeRound(args: string[]) {
  const identityPath = args[0];
  if (!identityPath || identityPath.startsWith("--")) return "sources prepare-recruitee-round requires an identity JSON file";
  let catalog = "data/companies.json";
  let artifactRoot = ".openings/round5-recruitee";
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--catalog") catalog = args[++index] ?? "";
    else if (arg === "--artifacts") artifactRoot = args[++index] ?? "";
    else return `Unknown option: ${arg}`;
    if (![catalog, artifactRoot].every(Boolean)) return `${arg} requires a path`;
  }
  if (!underOpenings(artifactRoot)) return "--artifacts must be under .openings";
  return { identityPath, catalog, artifactRoot };
}

function parseMergeAttemptedRoundLeads(args: string[]) {
  const isolatedRegistryPath = args[0];
  if (!isolatedRegistryPath || isolatedRegistryPath.startsWith("--")) return "sources merge-attempted-round-leads requires an isolated registry file";
  let registry = "data/enrichment-leads.json";
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--registry") { registry = args[++index] ?? ""; if (!registry) return "--registry requires a file"; }
    else return `Unknown option: ${arg}`;
  }
  return { isolatedRegistryPath, registry };
}

function parseYcCompanySeeds(args: string[]) {
  let output = ".openings/company-domains.json";
  let country: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--country") { country = parseCountry(args[++index]); if (!country) return "--country requires a two-letter country code"; }
    else if (arg === "--output") { output = args[++index] ?? ""; if (!output) return "--output requires a file"; }
    else return `Unknown option: ${arg}`;
  }
  if (!country) return "sources seed-companies-yc requires --country CODE";
  return { country, output };
}

function parseSourceEnrichment(args: string[]) {
  const firstCompanyInput = args[0];
  if (!firstCompanyInput || firstCompanyInput.startsWith("--")) return "sources enrich requires a company JSON file";
  const companies = [firstCompanyInput];
  let registry = "data/enrichment-leads.json";
  let output = "data/source-candidates.json";
  let report = ".openings/source-enrichment-report.json";
  let evidenceKind: "authoritative_dataset" | "company_registry" | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--registry") { registry = args[++index] ?? ""; if (!registry) return "--registry requires a file"; }
    else if (arg === "--companies") { const value = args[++index] ?? ""; if (!value) return "--companies requires a file"; companies.push(value); }
    else if (arg === "--output") { output = args[++index] ?? ""; if (!output) return "--output requires a file"; }
    else if (arg === "--report") { report = args[++index] ?? ""; if (!report) return "--report requires a file"; }
    else if (arg === "--evidence-kind") { const value = args[++index]; if (value !== "authoritative_dataset" && value !== "company_registry") return "--evidence-kind requires authoritative_dataset or company_registry"; evidenceKind = value; }
    else return `Unknown option: ${arg}`;
  }
  return { companies, registry, output, report, evidenceKind };
}

function parseSnapshotExport(args: string[]) {
  let input = ".openings/snapshot.json";
  let outputDir = ".openings/dist";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--input") { input = args[++index] ?? ""; if (!input) return "--input requires a file"; }
    else if (arg === "--output-dir") { outputDir = args[++index] ?? ""; if (!outputDir) return "--output-dir requires a path"; }
    else return `Unknown option: ${arg}`;
  }
  return { input, outputDir };
}

function parseCoverageReport(args: string[]) {
  let country: string | undefined;
  let snapshot = ".openings/snapshot.json";
  let catalog = "data/companies.json";
  let candidates = "data/source-candidates.json";
  let registry = "data/enrichment-leads.json";
  let output: string | undefined;
  let asOf: Date | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--country") { country = parseCountry(args[++index]); if (!country) return "--country requires a two-letter country code"; }
    else if (["--snapshot", "--catalog", "--candidates", "--registry", "--output"].includes(arg ?? "")) {
      const value = args[++index];
      if (!value) return `${arg} requires a file`;
      if (arg === "--snapshot") snapshot = value;
      else if (arg === "--catalog") catalog = value;
      else if (arg === "--candidates") candidates = value;
      else if (arg === "--registry") registry = value;
      else output = value;
    } else if (arg === "--as-of") {
      const value = args[++index];
      const parsed = value ? new Date(value) : undefined;
      if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) return "--as-of requires a canonical ISO timestamp";
      asOf = parsed;
    } else return `Unknown option: ${arg}`;
  }
  if (!country) return "coverage report requires --country CODE";
  return { country, snapshot, catalog, candidates, registry, output: output ?? `.openings/country-coverage-${country.toLowerCase()}.json`, asOf };
}

function parseCareerTracing(args: string[]) {
  const inputPath = args[0];
  if (!inputPath || inputPath.startsWith("--")) return "sources trace-careers requires a company JSON file";
  const parsed = parseDiscoveryOutputs(args.slice(1), ".openings/career-trace-report.json", true);
  return typeof parsed === "string" ? parsed : { inputPath, ...parsed };
}

function parseCommonCrawlDiscovery(args: string[]) {
  let output = "data/source-candidates.json";
  let report = ".openings/common-crawl-discovery-report.json";
  let country: string | undefined;
  let indexUrl: string | undefined;
  let registryPath: string | undefined = "data/enrichment-leads.json";
  let provider: Ats | undefined;
  let indexRecordLimit: number | undefined;
  let sampleTokenLimit: number | undefined;
  const excludeTokens: string[] = [];
  let reportOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--country") { country = parseCountry(args[++index]); if (!country) return "--country requires a two-letter country code"; }
    else if (arg === "--output") { output = args[++index] ?? ""; if (!output) return "--output requires a file"; }
    else if (arg === "--report") { report = args[++index] ?? ""; if (!report) return "--report requires a file"; }
    else if (arg === "--index-url") { indexUrl = args[++index]; if (!indexUrl) return "--index-url requires a URL"; try { new URL(indexUrl); } catch { return "--index-url requires a valid URL"; } }
    else if (arg === "--registry") { if (reportOnly) return "Use either --registry or --report-only, not both"; registryPath = args[++index] ?? ""; if (!registryPath) return "--registry requires a file"; }
    else if (arg === "--report-only") { if (registryPath !== "data/enrichment-leads.json") return "Use either --registry or --report-only, not both"; reportOnly = true; registryPath = undefined; }
    else if (arg === "--provider") { const value = args[++index]; if (!value || !(ALL_PROVIDERS as readonly string[]).includes(value)) return `--provider must be one of ${ALL_PROVIDERS.join(", ")}`; provider = value as Ats; }
    else if (arg === "--index-record-limit") { indexRecordLimit = Number(args[++index]); if (!Number.isInteger(indexRecordLimit) || indexRecordLimit < 1 || indexRecordLimit > 100_000) return "--index-record-limit must be an integer from 1 to 100000"; }
    else if (arg === "--sample-token-limit") { sampleTokenLimit = Number(args[++index]); if (!Number.isInteger(sampleTokenLimit) || sampleTokenLimit < 1 || sampleTokenLimit > 60) return "--sample-token-limit must be an integer from 1 to 60"; }
    else if (arg === "--exclude-token") { const value = args[++index]?.trim(); if (!value || !/^[a-z0-9-]+$/i.test(value)) return "--exclude-token requires an ATS token"; excludeTokens.push(value.toLowerCase()); }
    else return `Unknown option: ${arg}`;
  }
  if ((sampleTokenLimit !== undefined || excludeTokens.length || registryPath === undefined) && provider !== "recruitee") return "bounded report-only discovery requires --provider recruitee";
  if (provider === "recruitee" && indexRecordLimit !== undefined && indexRecordLimit > 2_000) return "--index-record-limit must be an integer from 1 to 2000 for --provider recruitee";
  if (provider === "recruitee" && (!indexUrl || indexRecordLimit === undefined || sampleTokenLimit === undefined || !reportOnly)) return "--provider recruitee requires --index-url, --index-record-limit, --sample-token-limit, and --report-only";
  if (provider === "recruitee" && !underOpenings(report)) return "bounded Recruitee discovery --report must be under .openings";
  if (sampleTokenLimit !== undefined && indexRecordLimit !== undefined && sampleTokenLimit > indexRecordLimit) return "--sample-token-limit cannot exceed --index-record-limit";
  return { output, report, country, indexUrl, registryPath, provider, indexRecordLimit, sampleTokenLimit, excludeTokens };
}

function parseDiscoveryOutputs(args: string[], defaultReport: string, requireCatalog: boolean) {
  let output = "data/source-candidates.json";
  let report = defaultReport;
  let catalog = "data/companies.json";
  let country: string | undefined;
  let concurrency = 10;
  let searchKey: string | undefined;
  let commonCrawlReportPath: string | undefined;
  let registryPath = "data/enrichment-leads.json";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--country") { country = parseCountry(args[++index]); if (!country) return "--country requires a two-letter country code"; }
    else if (arg === "--output") { output = args[++index] ?? ""; if (!output) return "--output requires a file"; }
    else if (arg === "--report") { report = args[++index] ?? ""; if (!report) return "--report requires a file"; }
    else if (arg === "--catalog" && requireCatalog) { catalog = args[++index] ?? ""; if (!catalog) return "--catalog requires a file"; }
    else if (arg === "--search-key-env") {
      const name = args[++index];
      if (!name) return "--search-key-env requires an environment variable name";
      searchKey = process.env[name];
      if (!searchKey) return `Environment variable ${name} is not set`;
    }
    else if (arg === "--common-crawl-report") {
      commonCrawlReportPath = args[++index];
      if (!commonCrawlReportPath) return "--common-crawl-report requires a file";
    }
    else if (arg === "--registry") { registryPath = args[++index] ?? ""; if (!registryPath) return "--registry requires a file"; }
    else if (arg === "--concurrency") { concurrency = Number(args[++index]); if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) return "--concurrency must be an integer from 1 to 100"; }
    else return `Unknown option: ${arg}`;
  }
  return { output, report, catalog, country, concurrency, searchKey, commonCrawlReportPath, registryPath };
}

function parseYcDiscovery(args: string[]) {
  let output = "data/source-candidates.json";
  let report = ".openings/yc-discovery-report.json";
  let catalog = "data/companies.json";
  let country: string | undefined;
  let concurrency = 10;
  let registryPath = "data/enrichment-leads.json";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--country") {
      country = parseCountry(args[++index]);
      if (!country) return "--country requires a two-letter country code";
    } else if (arg === "--output") output = args[++index] ?? "";
    else if (arg === "--registry") { registryPath = args[++index] ?? ""; if (!registryPath) return "--registry requires a file"; }
    else if (arg === "--catalog") catalog = args[++index] ?? "";
    else if (arg === "--report") report = args[++index] ?? "";
    else if (arg === "--concurrency") {
      concurrency = Number(args[++index]);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) return "--concurrency must be an integer from 1 to 100";
    } else return `Unknown option: ${arg}`;
  }
  if (!country) return "sources discover-yc requires --country CODE";
  if (!output) return "--output requires a file";
  if (!report) return "--report requires a file";
  if (!catalog) return "--catalog requires a file";
  return { output, report, catalog, country, concurrency, registryPath };
}

function parseSourceDiscovery(args: string[]) {
  const feedPath = args[0];
  if (!feedPath || feedPath.startsWith("--")) return "sources discover requires a feed JSON file";
  let output = "data/source-candidates.json";
  let report = ".openings/discovery-report.json";
  let catalog = "data/companies.json";
  let country: string | undefined;
  let concurrency = 10;
  let registryPath = "data/enrichment-leads.json";
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--country") {
      country = parseCountry(args[++index]);
      if (!country) return "--country requires a two-letter country code";
    } else if (arg === "--output") {
      output = args[++index] ?? "";
      if (!output) return "--output requires a file";
    } else if (arg === "--report") {
      report = args[++index] ?? "";
      if (!report) return "--report requires a file";
    } else if (arg === "--catalog") {
      catalog = args[++index] ?? "";
      if (!catalog) return "--catalog requires a file";
    } else if (arg === "--registry") {
      registryPath = args[++index] ?? "";
      if (!registryPath) return "--registry requires a file";
    } else if (arg === "--concurrency") {
      concurrency = Number(args[++index]);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) return "--concurrency must be an integer from 1 to 100";
    } else return `Unknown option: ${arg}`;
  }
  return { feedPath, output, report, catalog, country, concurrency, registryPath };
}

function parseSearch(args: string[]) {
  const queryWords: string[] = [];
  let location: string | undefined;
  let country: string | undefined;
  let remote: boolean | undefined;
  let limit: number | undefined;
  let offline = false;
  let staleDays = 14;
  let dataDir: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--location") {
      location = args[++index];
      if (!location) return "--location requires a value";
    } else if (arg === "--country") {
      country = parseCountry(args[++index]);
      if (!country) return "--country requires a two-letter country code";
    } else if (arg === "--remote") remote = true;
    else if (arg === "--india") country = "IN";
    else if (arg === "--onsite") remote = false;
    else if (arg === "--offline") offline = true;
    else if (arg === "--stale-days") {
      staleDays = Number(args[++index]);
      if (!Number.isFinite(staleDays) || staleDays < 0) return "--stale-days must be zero or greater";
    } else if (arg === "--data-dir") {
      dataDir = args[++index];
      if (!dataDir) return "--data-dir requires a value";
    }
    else if (arg === "--limit") {
      limit = Number(args[++index]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return "--limit must be an integer from 1 to 100";
    } else if (arg?.startsWith("--")) return `Unknown option: ${arg}`;
    else if (arg) queryWords.push(arg);
  }

  return { query: { query: queryWords.join(" ") || undefined, location, country, remote, limit }, offline, staleDays, dataDir };
}

function parseRuntimeOptions(args: string[]) {
  let offline = false;
  let staleDays = 14;
  let dataDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--offline") offline = true;
    else if (arg === "--stale-days") {
      staleDays = Number(args[++index]);
      if (!Number.isFinite(staleDays) || staleDays < 0) return "--stale-days must be zero or greater";
    } else if (arg === "--data-dir") {
      dataDir = args[++index];
      if (!dataDir) return "--data-dir requires a value";
    } else return `Unknown option: ${arg}`;
  }
  return { offline, staleDays, dataDir };
}

function parseCrawl(args: string[]) {
  let country: string | undefined;
  let companiesFile: string | undefined;
  let dataDir: string | undefined;
  let concurrency = 10;
  let delayMs = 0;
  let workdayPageDelayMs = 0;
  let timeoutMs: number | undefined;
  let workdayCountries: string[] | undefined;
  let sourceCacheHours = 24;
  let sourceLimit = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--country") {
      country = parseCountry(args[++index]);
      if (!country) return "--country requires a two-letter country code";
    } else if (arg === "--companies") companiesFile = args[++index];
    else if (arg === "--data-dir") dataDir = args[++index];
    else if (arg === "--concurrency") {
      concurrency = Number(args[++index]);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) return "--concurrency must be an integer from 1 to 100";
    } else if (arg === "--workday-countries") {
      const value = args[++index] ?? "";
      workdayCountries = value.split(",").map((code) => code.trim().toUpperCase()).filter(Boolean);
      if (!workdayCountries.every((code) => /^[A-Z]{2}$/.test(code))) return "--workday-countries must be a comma-separated list of two-letter codes";
    } else if (arg === "--delay-ms") {
      delayMs = Number(args[++index]);
      if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) return "--delay-ms must be an integer from 0 to 60000";
    } else if (arg === "--workday-page-delay-ms") {
      workdayPageDelayMs = Number(args[++index]);
      if (!Number.isInteger(workdayPageDelayMs) || workdayPageDelayMs < 0 || workdayPageDelayMs > 60_000) return "--workday-page-delay-ms must be an integer from 0 to 60000";
    } else if (arg === "--timeout-ms") {
      timeoutMs = Number(args[++index]);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1_800_000) return "--timeout-ms must be an integer from 1000 to 1800000";
    } else if (arg === "--source-cache-hours") {
      sourceCacheHours = Number(args[++index]);
      if (!Number.isFinite(sourceCacheHours) || sourceCacheHours < 0 || sourceCacheHours > 8760) return "--source-cache-hours must be a number from 0 to 8760";
    } else if (arg === "--source-limit") {
      sourceLimit = Number(args[++index]);
      if (!Number.isInteger(sourceLimit) || sourceLimit < 0 || sourceLimit > 100_000) return "--source-limit must be an integer from 0 to 100000";
    } else return `Unknown option: ${arg}`;
  }
  if (country && companiesFile) return "Use either --country or --companies, not both";
  if (args.includes("--companies") && !companiesFile) return "--companies requires a file";
  if (args.includes("--data-dir") && !dataDir) return "--data-dir requires a value";
  return { country, companiesFile, dataDir, concurrency, delayMs, workdayPageDelayMs, sourceCacheHours, sourceLimit, workdayCountries, timeoutMs };
}

function parseCountry(value: string | undefined): string | undefined {
  return value && /^[a-z]{2}$/i.test(value) ? value.toUpperCase() : undefined;
}

function underOpenings(path: string) { const root = resolve(".openings"); const relation = relative(root, resolve(path)); return Boolean(relation) && !relation.startsWith(".."); }

async function readCompanyFile(path: string): Promise<string[]> {
  return (await readFile(path, "utf8")).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

function parseDiscoverSubdomains(args: string[]): { seeds: string; output: string; limit?: number; delayMs?: number; report?: string } | string {
  const seeds = args[0];
  if (!seeds || seeds.startsWith("--")) return "sources discover-subdomains requires a seed JSON file of { companyName, companyDomain }";
  let output = ".openings/career-seeds-subdomains.json";
  let limit: number | undefined;
  let delayMs: number | undefined;
  let report: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") output = args[++index] ?? output;
    else if (arg === "--report") report = args[++index];
    else if (arg === "--limit") { limit = Number(args[++index]); if (!Number.isInteger(limit) || limit < 1) return "--limit must be a positive integer"; }
    else if (arg === "--delay-ms") { delayMs = Number(args[++index]); if (!Number.isInteger(delayMs) || delayMs < 0) return "--delay-ms must be a non-negative integer"; }
    else return `Unknown option: ${arg}`;
  }
  return { seeds, output, limit, delayMs, report };
}

function parseVerifyBoards(args: string[]): { registry: string; output: string; limit?: number; concurrency?: number; report?: string } | string {
  const registry = args[0];
  if (!registry || registry.startsWith("--")) return "sources verify-boards requires a registry JSON file";
  let output = "data/companies.json";
  let limit: number | undefined;
  let concurrency: number | undefined;
  let report: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") output = args[++index] ?? output;
    else if (arg === "--report") report = args[++index];
    else if (arg === "--limit") { limit = Number(args[++index]); if (!Number.isInteger(limit) || limit < 1) return "--limit must be a positive integer"; }
    else if (arg === "--concurrency") { concurrency = Number(args[++index]); if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) return "--concurrency must be an integer from 1 to 50"; }
    else return `Unknown option: ${arg}`;
  }
  return { registry, output, limit, concurrency, report };
}

function parseSourceVerification(args: string[]) {
  const candidatesPath = args[0];
  if (!candidatesPath || candidatesPath.startsWith("--")) return "sources verify requires a candidate JSON file";
  let output = "data/companies.json";
  let batchStatePath: string | undefined;
  let concurrency = 10;
  let workdayConcurrency = 2;
  let requireCountry: string | undefined;
  let registryPath: string | undefined;
  let retryDeferred = false;
  let limit: number | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") {
      output = args[++index] ?? "";
      if (!output) return "--output requires a file";
    } else if (arg === "--state-file") {
      batchStatePath = args[++index] ?? "";
      if (!batchStatePath) return "--state-file requires a file";
    } else if (arg === "--concurrency") {
      concurrency = Number(args[++index]);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) return "--concurrency must be an integer from 1 to 100";
    } else if (arg === "--workday-concurrency") {
      workdayConcurrency = Number(args[++index]);
      if (!Number.isInteger(workdayConcurrency) || workdayConcurrency < 1 || workdayConcurrency > 10) return "--workday-concurrency must be an integer from 1 to 10";
    } else if (arg === "--require-country") {
      requireCountry = parseCountry(args[++index]);
      if (!requireCountry) return "--require-country requires a two-letter country code";
    } else if (arg === "--limit") {
      limit = Number(args[++index]);
      if (!Number.isInteger(limit) || limit < 1) return "--limit must be a positive integer";
    } else if (arg === "--registry") {
      registryPath = args[++index];
      if (!registryPath) return "--registry requires a file";
    } else if (arg === "--retry-deferred") {
      retryDeferred = true;
    } else return `Unknown option: ${arg}`;
  }
  return { candidatesPath, output, batchStatePath, concurrency, workdayConcurrency, limit, requireCountry, registryPath, retryDeferred };
}

function fail(message: string, code = 1): number {
  console.error(message);
  return code;
}

function compactDiscoveryReport(report: import("./source-discovery.ts").SourceDiscoveryReport) {
  const { unresolved: _unresolved, rejections: _rejections, ...summary } = report;
  return summary;
}

function compactDiscoveryPromotion(result: import("./source-discovery-pipeline.ts").DiscoveryPromotionResult) {
  return { discovery: compactDiscoveryReport(result.discovery), promotion: result.promotion };
}

function compactCareerTraceReport(report: import("./career-tracing.ts").CareerTraceReport) {
  const { unresolvedCompanies: _unresolved, rejections: _rejections, failureDetails: _failures, ...summary } = report;
  return summary;
}

function compactCommonCrawlReport(report: import("./common-crawl-discovery.ts").CommonCrawlDiscoveryReport) {
  const { leads: _leads, availableLeads: _available, rejections: _rejections, ...summary } = report;
  return { ...summary, availableLeadCount: report.availableLeads.length, sampledLeadCount: report.leads.length };
}

if (import.meta.main) process.exitCode = await run(Bun.argv.slice(2));
