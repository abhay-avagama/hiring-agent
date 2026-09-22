import type { Catalog } from "./catalog.ts";
import type { RecommendJobsResult } from "./job-recommendations.ts";
import type { AnalyzeJobFitResult } from "./job-fit-analysis.ts";
import type { OptimizeResumeResult } from "./resume-optimization.ts";
import type { SearchQuery } from "./types.ts";
import type { SearchResult } from "./catalog.ts";
import type { JobCoverageSummary } from "./job-coverage.ts";
import type { PrepareJobSearchResult } from "./job-search-preparation.ts";

export interface ToolDefinition {
  name: "prepare_job_search" | "get_job_coverage" | "recommend_jobs" | "analyze_job_fit" | "optimize_resume" | "search_jobs" | "get_job";
  /** Human-readable name for a consent screen or tool picker, where a snake_case identifier reads poorly. */
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The shape of structuredContent. Deliberately permissive: a caller may rely on the fields named here, and a
   * result that grows a field must not fail validation in an app that pinned an older schema. */
  outputSchema: Record<string, unknown>;
  /** Nothing here applies, submits, or writes on the candidate's behalf. Preparation is the one tool that writes
   * at all: it caches the job index on disk, so claiming readOnlyHint for it would be untrue. */
  annotations: { readOnlyHint: boolean; destructiveHint: false; idempotentHint: true; openWorldHint: boolean };
}

/** Tools that reach employer boards over the network are open-world; the rest read the local index. */
const annotationsFor = (name: ToolDefinition["name"]): ToolDefinition["annotations"] =>
  ({ readOnlyHint: name !== "prepare_job_search", destructiveHint: false, idempotentHint: true, openWorldHint: name === "prepare_job_search" || name === "recommend_jobs" || name === "get_job" });

interface JobWorkflows {
  prepareJobSearch(input: unknown): Promise<PrepareJobSearchResult>;
  getJobCoverage(input: unknown): Promise<JobCoverageSummary>;
  recommend(input: unknown): Promise<RecommendJobsResult>;
  analyzeJobFit(input: unknown): Promise<AnalyzeJobFitResult>;
  optimizeResume(input: unknown): Promise<OptimizeResumeResult>;
}

export function createToolHandler(catalog: Catalog, workflows: JobWorkflows, options: { onCall?(name: string, input: Record<string, unknown>, result: unknown): void } = {}) {
  const definitions: Array<Omit<ToolDefinition, "annotations">> = [
    {
      name: "prepare_job_search",
      title: "Prepare job search",
      description: "Download and refresh the local job index so searches have data to read. The first call fetches the shared index of every verified source (thousands of employers); later calls crawl only missing or stale sources, at most 25 per call, returning a continuation token until nextAction reports ready. Call it when a search says setup is needed, not before every search, and not at all on the hosted server, where the index is already prepared and this returns ready at once. Uses the network and writes job data under the local Openings data directory; it never reads, writes or transmits a resume.",
      inputSchema: {
        type: "object",
        properties: {
          countries: { ...countryArray(), minItems: 1, maxItems: 20, description: "Two-letter codes whose sources should be prepared, such as IN or US" },
          continuation: { type: "string", description: "Opaque token from the previous call's result. Pass it back to prepare the next batch of at most 25 sources; omit it to start" },
        },
        required: ["countries"],
        additionalProperties: false,
      },
      outputSchema: output({
        status: { type: "string", enum: ["ready", "partial"], description: "ready means searches can run now; partial means sources are still missing" },
        nextAction: { type: "string", enum: ["ready", "call_again", "retry_later"], description: "call_again means pass continuation back for the next batch; retry_later means the network refused and waiting is the fix" },
        continuation: { type: "string", description: "Token for the next batch; present only when nextAction is call_again" },
        note: { type: "string" },
        networkAttempted: { type: "boolean", description: "Whether this call actually reached out to employer boards" },
        sources: { type: "object", additionalProperties: true, description: "How many sources are in the catalog, indexed, fresh, stale, missing and pending" },
        coverage: coverageSchema(),
        crawl: { type: "object", additionalProperties: true, description: "What this batch crawled: selected, succeeded, and the sources that failed" },
      }, ["status", "nextAction", "coverage"]),
    },
    {
      name: "get_job_coverage",
      title: "Check job coverage",
      description: "Report how many live roles the index holds for each country and how recently they were posted. Use it to set expectations before asking a candidate for anything, or to judge whether preparation is worth running; use search_jobs instead to see the roles themselves. Reads the index already on hand and never crawls.",
      inputSchema: {
        type: "object",
        properties: { countries: { ...countryArray(), minItems: 1, maxItems: 20, description: "Two-letter codes to report coverage for, such as IN or US" } },
        required: ["countries"],
        additionalProperties: false,
      },
      outputSchema: coverageSchema(),
    },
    {
      name: "recommend_jobs",
      title: "Recommend jobs from a resume",
      description: "Rank jobs against a resume, quoting the evidence for each match, and separate direct matches from hidden title-family and stretch roles. Use it when the candidate has chosen to share a resume and wants matching; prefer search_jobs for plain filtering, which needs no resume and answers faster. The resume is parsed in memory for this call and never stored. When matches are thin it may refresh the local snapshot once, per the refresh policy.",
      inputSchema: {
        type: "object",
        properties: {
          resume: resumeSchema(),
          intent: intentSchema(),
          ranking: {
            type: "object",
            description: "How matches are scored and how weak a match may be before it is dropped",
            properties: {
              mode: { type: "string", enum: ["evidence", "keyword"], default: "evidence", description: "evidence scores a match only on requirements the resume text supports; keyword scores on term overlap alone" },
              minimumPercent: { type: "number", minimum: 0, maximum: 100, default: 0 },
            },
            additionalProperties: false,
          },
          refresh: {
            type: "object",
            description: "Whether this call may crawl employer boards before ranking. Crawling costs seconds; the default only does it when the result would otherwise be thin",
            properties: {
              policy: { type: "string", enum: ["auto", "never", "always"], default: "auto", description: "auto crawls once only when matches are thin and the snapshot is stale; never keeps the snapshot as it is; always crawls first" },
              minimumMatches: { type: "integer", minimum: 0, default: 5, description: "With auto, the match count below which a refresh is worth the wait" },
              staleDays: { type: "number", minimum: 0, default: 14, description: "With auto, how old the snapshot must be before a refresh is considered" },
            },
            additionalProperties: false,
          },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "How many ranked matches to return" },
        },
        required: ["resume", "intent"], additionalProperties: false,
      },
      outputSchema: output({
        outcome: { type: "string", enum: ["matches", "widened", "no_matches"], description: "widened means the date window had to open up to find anything; no_matches means say so rather than searching again silently" },
        matches: { type: "array", description: "Ranked matches, each carrying the job, its scores, and the resume text that supports them", items: { type: "object", additionalProperties: true } },
        explanation: { type: "string", description: "Why the result looks the way it does, in words meant for the candidate" },
        nextMoves: { type: "array", items: { type: "string" }, description: "What to try next when the result is thin; relay these instead of inventing advice" },
        window: { type: "object", additionalProperties: true, description: "Which age windows were walked and which one the results came from" },
        profile: { type: "object", additionalProperties: true, description: "What was read from the resume. It is returned so claims can be checked, and is not stored" },
        exploration: { type: "object", additionalProperties: true, description: "Direct, hidden title-family and stretch groupings" },
        filteredOut: { type: "object", additionalProperties: true, description: "Counts by reason, with a small sample, for roles the intent excluded" },
        assumptions: { type: "array", items: { type: "string" }, description: "Anything inferred rather than stated; worth repeating to the candidate" },
        ranking: { type: "object", additionalProperties: true },
        coverage: coverageSchema(),
        snapshot: { type: "object", additionalProperties: true, description: "Age and size of the index these matches came from" },
        refresh: { type: "object", additionalProperties: true, description: "Whether this call crawled, and what it found" },
        shortfall: { type: "object", additionalProperties: true, description: "Present when fewer matches came back than asked for" },
        nextActions: { type: "array", items: { type: "string" } },
      }, ["outcome", "matches", "explanation"]),
    },
    {
      name: "analyze_job_fit",
      title: "Analyze fit for one job",
      description: "Explain how one job fits a resume: which requirements the resume supports, which it does not, the screening risks, and what to prepare for an interview, each tied to text quoted from the resume rather than inferred. Use it after search_jobs or recommend_jobs has produced a job id and the candidate wants depth on a single role instead of a list. The resume is parsed in memory for this call and never stored.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", minLength: 1, description: "Stable job id from search_jobs or recommend_jobs" },
          resume: resumeSchema(), intent: intentSchema(),
        },
        required: ["jobId", "resume"], additionalProperties: false,
      },
      outputSchema: output({
        job: jobSchema("The job that was analyzed"),
        assessment: { type: "object", additionalProperties: true, description: "The overall read, with its reasoning" },
        scores: { type: "object", additionalProperties: true },
        supported: { type: "array", items: { type: "object", additionalProperties: true }, description: "Requirements the resume supports, each with the quoted evidence" },
        partiallySupported: { type: "array", items: { type: "object", additionalProperties: true }, description: "Requirements with partial evidence, and what is missing" },
        unsupported: { type: "array", items: { type: "string" }, description: "Requirements the resume does not evidence at all" },
        screeningRisks: { type: "array", items: { type: "string" }, description: "What is likely to stop this application early" },
        interviewPreparationGaps: { type: "array", items: { type: "string" } },
        profile: { type: "object", additionalProperties: true, description: "What was read from the resume; not stored" },
      }, ["job", "assessment"]),
    },
    {
      name: "optimize_resume",
      title: "Optimize a resume for one job",
      description: "Propose a revision of a resume for one specific job, as suggestions, a unified diff or revised markdown. It rewrites emphasis and wording only: the original is never overwritten and no claim the resume does not already support is added. Use it after analyze_job_fit has shown which gaps are real. The resume is parsed in memory for this call and never stored.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", minLength: 1, description: "Stable job id from search_jobs or recommend_jobs" },
          resume: resumeSchema(),
          output: { type: "string", enum: ["suggestions", "unified_diff", "revised_markdown"], description: "suggestions lists changes to consider; unified_diff shows them as a patch; revised_markdown returns the rewritten resume" },
        },
        required: ["jobId", "resume", "output"], additionalProperties: false,
      },
      outputSchema: output({
        output: { type: "string", enum: ["suggestions", "unified_diff", "revised_markdown"], description: "Which form was produced" },
        suggestions: { type: "array", items: { type: "object", additionalProperties: true }, description: "Each proposed change with the evidence behind it" },
        content: { type: "string", description: "The diff or rewritten resume, when that form was asked for" },
        gaps: { type: "array", items: { type: "string" }, description: "What the resume cannot honestly claim, and so was left alone" },
        job: jobSchema("The job the revision targets"),
        profile: { type: "object", additionalProperties: true },
        originalOverwritten: { type: "boolean", description: "Always false: the candidate's resume is never modified in place" },
      }, ["output", "suggestions", "originalOverwritten"]),
    },
    {
      name: "search_jobs",
      title: "Search jobs",
      description: "Search jobs immediately from role, country, location and optional stated experience. No resume required. Newest first; automatically widens 7, 14, 30 days then all dates until 5 matches. For another page reuse the same filters and returned window.daysUsed as maxAgeDays, with pagination.nextOffset. Resume-based ranking is optional via recommend_jobs.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to match in job title or company" },
          location: { type: "string", description: "Case-insensitive location substring" },
          country: { type: "string", pattern: "^[A-Za-z]{2}$", description: "Two-letter country code for job eligibility, such as IN or DE" },
          remote: { type: "boolean", description: "True for remote-only; false for non-remote-only" },
          maxAgeDays: { type: "integer", minimum: 0, maximum: 365, description: "Omit to widen 7/14/30/all until 5 matches. Explicit positive values exclude undated roles; 0 includes all dates." },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50, description: "How many jobs to return in this page" },
          offset: { type: "integer", minimum: 0, maximum: 1000000, default: 0, description: "Where the page starts. Use pagination.nextOffset from the previous result rather than counting by hand" },
          experienceYears: { type: "number", minimum: 0, maximum: 60, description: "Years of experience to compare with the posting's stated min/max range; not a qualification or fit verdict." },
          includeUnknownExperience: { type: "boolean", default: false, description: "With experienceYears, also keep roles without a stated range, clearly unknown rather than matched." },
        },
        additionalProperties: false,
      },
      outputSchema: output({
        jobs: { type: "array", items: jobSchema("One matching job"), description: "Matches, newest first" },
        window: { type: "object", additionalProperties: true, description: "The age window the results came from, and whether it had to widen. Say which window was used" },
        pagination: { type: "object", additionalProperties: true, description: "offset, limit, total and nextOffset. nextOffset is null on the last page" },
        guidance: { type: "string", description: "How to present these results honestly; meant for the assistant, not the candidate" },
      }, ["jobs", "window", "pagination"]),
    },
    {
      name: "get_job",
      title: "Get job details",
      description: "Get the full description and application URL for a job returned by recommend_jobs or search_jobs.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Stable job id returned by search_jobs or recommend_jobs (jobId is accepted too)" } },
        required: ["id"],
        additionalProperties: false,
      },
      outputSchema: output({ job: jobSchema("The full job, including its description and the employer's application URL") }, ["job"]),
    },
  ];

  return {
    list: () => definitions.map((definition) => ({ ...definition, annotations: annotationsFor(definition.name) })),
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
        assertToolKeys(input, ["query", "location", "country", "remote", "maxAgeDays", "limit", "offset", "experienceYears", "includeUnknownExperience"], "search_jobs");
        if (input.offset !== undefined && (!Number.isInteger(input.offset) || (input.offset as number) < 0 || (input.offset as number) > 1000000)) throw new Error("offset must be an integer between 0 and 1000000");
        if (input.experienceYears !== undefined && (typeof input.experienceYears !== "number" || !Number.isFinite(input.experienceYears) || input.experienceYears < 0 || input.experienceYears > 60)) throw new Error("experienceYears must be a number between 0 and 60");
        if (input.includeUnknownExperience !== undefined && typeof input.includeUnknownExperience !== "boolean") throw new Error("includeUnknownExperience must be a boolean");
        if (input.query !== undefined && typeof input.query !== "string") throw new Error("query must be a string");
        if (input.location !== undefined && typeof input.location !== "string") throw new Error("location must be a string");
        if (input.remote !== undefined && typeof input.remote !== "boolean") throw new Error("remote must be a boolean");
        if (input.maxAgeDays !== undefined && (!Number.isInteger(input.maxAgeDays) || (input.maxAgeDays as number) < 0 || (input.maxAgeDays as number) > 365)) throw new Error("maxAgeDays must be an integer between 0 and 365");
        if (input.limit !== undefined && (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100)) throw new Error("limit must be an integer between 1 and 100");
        const query: SearchQuery = {};
        if (typeof input.query === "string") query.query = input.query;
        if (typeof input.location === "string") query.location = input.location;
        if (typeof input.country === "string" && /^[a-z]{2}$/i.test(input.country)) query.country = input.country.toUpperCase();
        else if (input.country !== undefined) throw new Error("country must be a two-letter code");
        if (typeof input.remote === "boolean") query.remote = input.remote;
        if (typeof input.maxAgeDays === "number") query.maxAgeDays = input.maxAgeDays;
        if (typeof input.limit === "number") query.limit = input.limit;
        if (typeof input.offset === "number") query.offset = input.offset;
        if (typeof input.experienceYears === "number") query.experienceYears = input.experienceYears;
        if (typeof input.includeUnknownExperience === "boolean") query.includeUnknownExperience = input.includeUnknownExperience;
        const jobs = await catalog.search(query) as SearchResult;
        return {
          jobs, window: jobs.window, pagination: jobs.pagination,
          guidance: "Unranked keyword matches. Experience filters compare stated ranges only; unknown experience is not a match or a gap. Present older/stale roles as possibly still open, not current. Reuse window.daysUsed as maxAgeDays and pagination.nextOffset with unchanged filters for the next page. Pagination is over the current index, not a frozen snapshot; restart if the index refreshes. Resume-based matching is optional.",
        };
      }
      if (name === "get_job") {
        // analyze_job_fit and optimize_resume call it jobId, so accept either spelling rather than fail on a near miss.
        assertToolKeys(input, ["id", "jobId"], "get_job");
        const id = typeof input.id === "string" && input.id ? input.id : input.jobId;
        if (typeof id !== "string" || !id) throw new Error("get_job requires a non-empty id");
        return { job: await catalog.get(id) };
      }
      throw new Error(`Unknown tool: ${name}`);
  }
}

function resumeSchema(): Record<string, unknown> {
  return {
    type: "object",
    description: "The resume itself, passed inline. It is parsed in memory for this call and never written to disk, logged, or sent anywhere else.",
    properties: {
      content: { type: "string", minLength: 1, description: "Resume content supplied directly; filesystem paths are not accepted" },
      format: { type: "string", enum: ["text", "markdown", "pdf_base64", "docx_base64"], description: "How content is encoded: plain text, markdown, or base64 of a PDF or DOCX file" },
    },
    required: ["content", "format"], additionalProperties: false,
  };
}

function intentSchema(): Record<string, unknown> {
  return {
    type: "object",
    description: "What the candidate is actually looking for, stated explicitly rather than guessed from the resume. Every field is optional; the ones given narrow the result, and the excluded* fields remove roles the candidate does not want to see.",
    properties: {
      roles: { ...stringArray(), description: "Role titles the candidate is looking for, in their own words, such as \"backend engineer\" or \"data analyst\". Matched against the job title" },
      countries: { ...countryArray(), description: "Two-letter codes the candidate may work in, such as IN or US. This is eligibility to work, not where the office is" },
      locations: { ...stringArray(), description: "Cities or regions to keep, matched as case-insensitive substrings of the job's location, such as \"Bengaluru\" or \"Delhi NCR\"" },
      remote: { type: "boolean", description: "True to keep only remote roles, false to drop them; omit to keep both" },
      seniority: { ...stringArray(), description: "Levels to keep, in the posting's own vocabulary, such as \"senior\" or \"lead\". Not a years-of-experience filter: use experienceYears in search_jobs for that" },
      requiredSkills: { ...stringArray(), description: "Skills a role must state to be kept, such as \"kubernetes\". Each is matched as a whole word" },
      excludedTerms: { ...stringArray(), description: "Words that disqualify a role, matched as whole words in the title, such as \"intern\" or \"sales\"" },
      excludedCountries: { ...countryArray(), description: "Two-letter codes to drop even when a role is otherwise eligible" },
      excludedLocations: { ...stringArray(), description: "Cities or regions to drop, matched like locations" },
      excludedRoles: { ...stringArray(), description: "Role titles to drop, matched like roles" },
      maxAgeDays: { type: "integer", minimum: 0, maximum: 365, description: "Only roles posted within this many days. Default 30 (undated roles kept); an explicit value also drops undated roles; 0 includes older roles" },
    },
    additionalProperties: false,
  };
}

/** An object schema that documents the fields a caller can rely on without forbidding the ones it does not know. */
function output(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: true };
}

function jobSchema(description: string): Record<string, unknown> {
  return {
    type: "object", description, additionalProperties: true,
    properties: {
      id: { type: "string", description: "Stable id to pass to get_job, analyze_job_fit or optimize_resume" },
      title: { type: "string" }, company: { type: "string" }, location: { type: "string" },
      remote: { type: "boolean" }, workMode: { type: "string", enum: ["remote", "hybrid", "onsite", "unknown"] },
      url: { type: "string", description: "The employer's own posting, which is where an application is made" },
      updatedAt: { type: "string", description: "When the board says the role was posted or last updated; absent when the board states none" },
      age: { type: "string", enum: ["new", "older", "stale", "undated"], description: "Bucketed posting age; undated means the board gave no date, not that the role is fresh" },
      postedDaysAgo: { type: "number" },
      experience: { type: ["object", "null"], description: "Years the posting itself states as { min, max }; null when it states none, absent when the description was not read", additionalProperties: true },
      eligibleCountries: { type: "array", items: { type: "string" }, description: "Two-letter codes the role is open to" },
    },
  };
}

function coverageSchema(): Record<string, unknown> {
  return output({
    snapshotUpdatedAt: { type: "string", description: "When the index this answer came from was last refreshed" },
    countries: { type: "array", description: "Per-country live and recent role counts", items: { type: "object", additionalProperties: true } },
  });
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
