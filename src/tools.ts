import type { Catalog } from "./catalog.ts";
import type { RecommendJobsResult } from "./job-recommendations.ts";
import type { AnalyzeJobFitResult } from "./job-fit-analysis.ts";
import type { OptimizeResumeResult } from "./resume-optimization.ts";
import type { SearchQuery } from "./types.ts";
import type { JobCoverageSummary } from "./job-coverage.ts";
import type { PrepareJobSearchResult } from "./job-search-preparation.ts";

export interface ToolDefinition {
  name: "prepare_job_search" | "get_job_coverage" | "recommend_jobs" | "analyze_job_fit" | "optimize_resume" | "search_jobs" | "get_job";
  description: string;
  inputSchema: Record<string, unknown>;
}

interface JobWorkflows {
  prepareJobSearch(input: unknown): Promise<PrepareJobSearchResult>;
  getJobCoverage(input: unknown): Promise<JobCoverageSummary>;
  recommend(input: unknown): Promise<RecommendJobsResult>;
  analyzeJobFit(input: unknown): Promise<AnalyzeJobFitResult>;
  optimizeResume(input: unknown): Promise<OptimizeResumeResult>;
}

export function createToolHandler(catalog: Catalog, workflows: JobWorkflows, options: { onCall?(name: string, input: Record<string, unknown>, result: unknown): void } = {}) {
  const definitions: ToolDefinition[] = [
    {
      name: "prepare_job_search",
      description: "Initialize or refresh the local job index from verified public sources in resumable batches of at most ten, then report current coverage and whether to call again. This may use the network and write only job data under the local Openings data directory; it never processes a resume.",
      inputSchema: {
        type: "object",
        properties: {
          countries: { ...countryArray(), minItems: 1, maxItems: 20 },
          continuation: { type: "string", description: "Opaque token returned by the preceding preparation batch" },
        },
        required: ["countries"],
        additionalProperties: false,
      },
    },
    {
      name: "get_job_coverage",
      description: "Report current job-level coverage for one or more countries before a candidate supplies a resume.",
      inputSchema: {
        type: "object",
        properties: { countries: { ...countryArray(), minItems: 1, maxItems: 20 } },
        required: ["countries"],
        additionalProperties: false,
      },
    },
    {
      name: "recommend_jobs",
      description: "Parse a resume, apply explicit job intent, rank evidence-grounded matches, separate direct, hidden title-family, and stretch opportunities, and optionally refresh the local snapshot once.",
      inputSchema: {
        type: "object",
        properties: {
          resume: resumeSchema(),
          intent: intentSchema(),
          ranking: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["evidence", "keyword"], default: "evidence" },
              minimumPercent: { type: "number", minimum: 0, maximum: 100, default: 0 },
            },
            additionalProperties: false,
          },
          refresh: {
            type: "object",
            properties: {
              policy: { type: "string", enum: ["auto", "never", "always"], default: "auto" },
              minimumMatches: { type: "integer", minimum: 0, default: 5 },
              staleDays: { type: "number", minimum: 0, default: 14 },
            },
            additionalProperties: false,
          },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        required: ["resume", "intent"], additionalProperties: false,
      },
    },
    {
      name: "analyze_job_fit",
      description: "Analyze one stable job id against explicit, verbatim resume evidence; report support, gaps, screening risks, and interview preparation without inventing candidate facts.",
      inputSchema: {
        type: "object",
        properties: { jobId: { type: "string", minLength: 1 }, resume: resumeSchema(), intent: intentSchema() },
        required: ["jobId", "resume"], additionalProperties: false,
      },
    },
    {
      name: "optimize_resume",
      description: "Propose an evidence-grounded resume revision for one selected job without overwriting the original or inserting unsupported claims.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", minLength: 1 },
          resume: resumeSchema(),
          output: { type: "string", enum: ["suggestions", "unified_diff", "revised_markdown"] },
        },
        required: ["jobId", "resume", "output"], additionalProperties: false,
      },
    },
    {
      name: "search_jobs",
      description: "Search the local job snapshot by role, location, country eligibility, and work mode.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to match in job title or company" },
          location: { type: "string", description: "Case-insensitive location substring" },
          country: { type: "string", pattern: "^[A-Za-z]{2}$", description: "Two-letter country code for job eligibility, such as IN or DE" },
          remote: { type: "boolean", description: "True for remote-only; false for non-remote-only" },
          maxAgeDays: { type: "integer", minimum: 1, maximum: 365, description: "Only roles posted within this many days; results are newest first" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_job",
      description: "Get the full description and application URL for a job returned by recommend_jobs or search_jobs.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Stable job id returned by search_jobs" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  ];

  return {
    list: () => definitions,
    async call(name: string, input: Record<string, unknown>) {
      const result = await dispatch(name, input);
      try { options.onCall?.(name, input, result); } catch { /* usage reporting never affects a tool result */ }
      return result;
    },
  };

  async function dispatch(name: string, input: Record<string, unknown>): Promise<unknown> {
      if (name === "prepare_job_search") return workflows.prepareJobSearch(input);
      if (name === "get_job_coverage") return workflows.getJobCoverage(input);
      if (name === "recommend_jobs") return workflows.recommend(input);
      if (name === "analyze_job_fit") return workflows.analyzeJobFit(input);
      if (name === "optimize_resume") return workflows.optimizeResume(input);
      if (name === "search_jobs") {
        assertToolKeys(input, ["query", "location", "country", "remote", "maxAgeDays", "limit"], "search_jobs");
        if (input.query !== undefined && typeof input.query !== "string") throw new Error("query must be a string");
        if (input.location !== undefined && typeof input.location !== "string") throw new Error("location must be a string");
        if (input.remote !== undefined && typeof input.remote !== "boolean") throw new Error("remote must be a boolean");
        if (input.maxAgeDays !== undefined && (!Number.isInteger(input.maxAgeDays) || (input.maxAgeDays as number) < 1 || (input.maxAgeDays as number) > 365)) throw new Error("maxAgeDays must be an integer between 1 and 365");
        if (input.limit !== undefined && (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100)) throw new Error("limit must be an integer between 1 and 100");
        const query: SearchQuery = {};
        if (typeof input.query === "string") query.query = input.query;
        if (typeof input.location === "string") query.location = input.location;
        if (typeof input.country === "string" && /^[a-z]{2}$/i.test(input.country)) query.country = input.country.toUpperCase();
        else if (input.country !== undefined) throw new Error("country must be a two-letter code");
        if (typeof input.remote === "boolean") query.remote = input.remote;
        if (typeof input.maxAgeDays === "number") query.maxAgeDays = input.maxAgeDays;
        if (typeof input.limit === "number") query.limit = input.limit;
        return { jobs: await catalog.search(query) };
      }
      if (name === "get_job") {
        assertToolKeys(input, ["id"], "get_job");
        if (typeof input.id !== "string" || !input.id) throw new Error("get_job requires a non-empty id");
        return { job: await catalog.get(input.id) };
      }
      throw new Error(`Unknown tool: ${name}`);
  }
}

function resumeSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      content: { type: "string", minLength: 1, description: "Resume content supplied directly; filesystem paths are not accepted" },
      format: { type: "string", enum: ["text", "markdown", "pdf_base64", "docx_base64"] },
    },
    required: ["content", "format"], additionalProperties: false,
  };
}

function intentSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      roles: stringArray(), countries: countryArray(), locations: stringArray(), remote: { type: "boolean" }, seniority: stringArray(),
      requiredSkills: stringArray(), excludedTerms: stringArray(),
      excludedCountries: countryArray(), excludedLocations: stringArray(), excludedRoles: stringArray(),
      maxAgeDays: { type: "integer", minimum: 1, maximum: 365, description: "Only roles posted within this many days" },
    },
    additionalProperties: false,
  };
}

function assertToolKeys(input: Record<string, unknown>, allowed: string[], tool: string): void {
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${tool} does not accept field: ${unknown}`);
}

function stringArray(): Record<string, unknown> {
  return { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true };
}

function countryArray(): Record<string, unknown> {
  return { type: "array", items: { type: "string", pattern: "^[A-Za-z]{2}$" }, uniqueItems: true };
}
