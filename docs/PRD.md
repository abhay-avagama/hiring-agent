# PRD — Openings: an MCP-native job-search workflow

**Working title:** Openings  
**Status:** Draft v0.3
**Primary release:** v1 — resume-to-opportunity workflow  
**One-liner:** A free, local MCP server that turns a user's resume and stated intent into an explained shortlist of real jobs, refreshes verified job sources when necessary, and proposes truthful job-specific resume improvements.

## Current execution priority

Version 0.2 pivoted implementation from source expansion to the resume-to-opportunity workflow. That v1 core is now operational: candidate-profile extraction, evidence validation, explainable matching, `recommend_jobs`, conditional refresh, `analyze_job_fit`, `optimize_resume`, and the thin MCP skill wrapper are shipped and tested.

Version 0.3 resumes bounded source and corpus expansion because useful breadth is part of the user-facing value: Openings should surface relevant public jobs that exact-title searches overlook. Expansion is measured by eligible jobs, distinct eligible employers, source health, provider diversity, eligibility confidence, and freshness—not raw source-token count alone.

Request-time and maintainer responsibilities remain separate. Recommendation may search the local snapshot and refresh relevant verified sources at most once according to the requested refresh policy; it must never discover arbitrary new sources. Discovery, identity verification, catalog promotion, and large expansion campaigns remain maintainer workflows. Distributed aggregation remains parked for v2.

## Product decision

Openings is an MCP product. End users should not need to run CLI commands or understand ATS providers, snapshots, catalogs, crawlers, or enrichment campaigns. The CLI remains a maintainer and diagnostic surface.

Openings does not host an AI model or require an Openings API key. The user's MCP host supplies the conversational interface and, where appropriate, its own model. Openings supplies local parsing, verified job data, deterministic filtering, explainable matching evidence, conditional crawling, and guarded resume-revision output through MCP tools.

Three constraints remain fixed:

1. Nothing auto-applies or submits an application.
2. Nothing invents resume facts, skills, dates, employers, qualifications, or metrics.
3. Resume content stays local and ephemeral; it is never written to job snapshots, source registries, campaign reports, or logs.

## v1 objective

A user should be able to give their MCP host a resume, state what they want, and receive useful jobs without learning Openings commands.

The user workflow is:

1. Parse the resume into supported facts and explicit inferences.
2. Match those facts and the user's stated intent against the current job snapshot.
3. If too few suitable jobs are found, conditionally refresh relevant verified sources and match once more.
4. For a selected job, explain fit and propose evidence-grounded resume improvements.

The v1 core optimizes usability and recommendation quality over the local verified substrate. Measure the current corpus first, build candidate-driven exploration next, and use the resulting coverage gaps to guide bounded catalog expansion. Distributed aggregation remains parked for v2.

## Who it is for

- Job seekers who already use an MCP-capable agent and want it grounded in current, first-party job openings.
- Users who want a free local workflow without accounts, hosted resume storage, or an Openings-owned model subscription.
- Agent builders who need structured, explainable job and resume tools rather than a generic jobs search endpoint.

**Not for:** recruiters sourcing candidates, unattended application automation, or centralized resume collection.

## User experience

The normal interaction is conversational:

> Here is my resume. I want backend or platform roles eligible for India, preferably remote. Find the best opportunities.

The MCP host calls `recommend_jobs`. Openings parses the resume, applies hard eligibility constraints, ranks the remaining jobs, optionally refreshes the snapshot, and returns an explained shortlist. The user can then ask why a job fits or request a truthful resume revision plan for that job.

No terminal command is part of the end-user journey.

## Ownership of resume reasoning

The MCP modules are the single source of truth for candidate facts, matching evidence, fit classifications, gaps, and permitted resume revisions. The host model may collect intent and present or summarize tool results, but the repository skill must not maintain a second parsing, matching, or tailoring implementation with different guarantees.

`skills/openings/SKILL.md` is now a thin conversational wrapper around the MCP tools. It:

1. Collects missing user intent.
2. Supplies resume content to the MCP tools.
3. Presents the returned evidence and proposed changes.
4. Requires human review.

The skill must not independently read arbitrary resume paths, calculate fit, create an alternate resume diff, or retain cover-letter generation in the v1 critical path. There must be only one enforceable implementation of the no-fabrication and evidence-traceability rules: the MCP modules.

## MCP interface

### `recommend_jobs`

The primary deep module. One call hides resume parsing, profile construction, filtering, ranking, refresh decisions, one optional crawl, rematching, and explanation generation.

Input:

```ts
{
  resume: {
    content: string;
    format: "text" | "markdown" | "pdf_base64" | "docx_base64";
  };
  intent: {
    roles?: string[];
    countries?: string[];
    locations?: string[];
    remote?: boolean;
    seniority?: string[];
    requiredSkills?: string[];
    excludedTerms?: string[];
  };
  ranking?: {
    mode?: "evidence" | "keyword";
    minimumPercent?: number;
  };
  refresh?: {
    policy: "auto" | "never" | "always";
    minimumMatches?: number;
    staleDays?: number;
  };
  limit?: number;
}
```

Output includes:

- A structured candidate profile with resume evidence.
- Assumptions or missing intent that the user may want to clarify.
- Ranked jobs labelled `strong`, `good`, or `stretch`.
- Both an evidence percentage and a raw keyword-overlap percentage for every match, plus the applicant-selected ranking score. Evidence ranking is the default; an optional minimum percentage filters the selected score.
- Match reasons, supported requirements, and material gaps.
- Snapshot freshness and whether a refresh occurred.
- Crawl failures without losing successful results.
- Suggested next actions, such as deeper fit analysis for a selected job.

### `get_job`

Returns the complete normalized description for one stable job ID. This remains read-only.

### `analyze_job_fit`

Performs deeper analysis for a selected job using the resume and optional intent.

```ts
{
  jobId: string;
  resume: ResumeInput;
  intent?: CandidateIntent;
}
```

Output separates:

- Requirements supported by explicit resume evidence.
- Partially supported or transferable experience.
- Unsupported requirements.
- Likely screening risks.
- Interview-preparation gaps, which are not automatically resume-editing opportunities.
- An explained `strong | good | stretch | poor` fit assessment.

### `optimize_resume`

Produces a proposed job-specific revision, never an application submission.

```ts
{
  jobId: string;
  resume: ResumeInput;
  output: "suggestions" | "unified_diff" | "revised_markdown";
}
```

Every proposed claim must link back to evidence already present in the supplied resume. Unsupported requirements are reported as gaps and must never be inserted as candidate experience. The tool returns content to the MCP host; it does not overwrite the original resume.

### Existing `search_jobs`

Retain `search_jobs` as a lower-level tool for direct queries and agent experimentation. It is not the primary v1 experience and does not parse resumes or trigger crawling.

## Resume parsing and candidate profile

Resume parsing produces three deliberately separate categories:

- **Facts:** skills, roles, dates, projects, education, certifications, and outcomes explicitly supported by resume text.
- **Inferences:** role family, seniority, transferable skills, and approximate experience derived from those facts.
- **Intent:** roles, geography, work mode, seniority, and exclusions stated by the user.

Intent overrides inference. Openings must not infer work authorization, willingness to relocate, salary expectations, remote preference, or geographic eligibility from silence.

Each extracted fact retains a short evidence reference to its originating resume section or text span. This evidence is the grounding source for fit explanations and resume revisions.

Evidence references are mechanically verifiable, not model-authored paraphrases. Every fact stores at least one literal, verbatim span copied from the normalized resume text plus stable start/end character offsets into that exact text. A fact is invalid when its quoted span does not equal the referenced substring. Normalization must be deterministic and returned with the profile so later tools validate against the same text representation. Fit claims and resume suggestions may cite only validated fact IDs; a populated citation field alone is never sufficient evidence.

Facts are the only extracted source of truth. Inferences are derived from the current fact set and explicit rules each time a candidate profile is constructed; they are not independently accumulated or accepted as evidence. Intent remains separately supplied by the user and may override an inference, but it cannot manufacture a fact. This follows the same facts-versus-derived-state discipline used by the enrichment registry.

V1 should support text and Markdown first. PDF and DOCX may initially be converted to text by the MCP host; native local extraction can follow without changing the MCP interface.

The `pdf_base64` and `docx_base64` format values are reserved for interface compatibility, not a v1 commitment to native document parsing. Until native extraction ships, the MCP tool must reject those values with the stable error `{ code: "unsupported_resume_format", format: "pdf_base64" | "docx_base64", supportedFormats: ["text", "markdown"] }`. Malformed supported input uses a different `invalid_resume_input` code. Hosts should submit extracted text or Markdown.

The workflow is intentionally stateless. `recommend_jobs`, `analyze_job_fit`, and `optimize_resume` each receive the resume content required for that call; derived candidate profiles are not persisted or referenced through a server-side profile ID. Re-supplying the resume costs additional payload size but avoids resume storage, lifecycle management, cross-session leakage, and deletion semantics.

## Matching policy

Matching has two stages.

### Hard filters

- Job eligibility includes a requested country when country intent is supplied.
- Explicitly excluded countries, locations, roles, or terms are rejected.
- Work mode and location constraints are enforced when explicitly requested.
- Stale jobs are handled according to the refresh policy.

Company campaign membership never substitutes for job eligibility.

### Relevance ordering

Remaining jobs are ordered using:

- Role and responsibility similarity.
- Demonstrated required skills.
- Transferable skills.
- Seniority and experience alignment.
- User preferences.
- Evidence strength and job freshness.

Applicants may select evidence or keyword ranking and receive both percentages for comparison. Percentages supplement rather than replace supported requirements, gaps, screening risks, and evidence references. Evidence ranking is the default and counts only validated facts and explicitly derived transferable evidence; keyword ranking measures unique term presence in the raw supplied resume and must never be described as competence. Keyword frequency cannot inflate either score. Mandatory experience or education shortfalls cap both percentages below 80, and hard eligibility or exclusion constraints remain filters in every mode.

The evidence percentage uses fixed contributions for role-family alignment, mandatory requirement coverage, and seniority or experience alignment. Unknown job requirements earn no requirement credit; a title-only record therefore cannot claim 100% evidence. Explicit resume titles may establish seniority, while completed date spans provide conservative alignment when no title level exists. Keyword percentage remains intentionally separate and may be high despite weak evidence; the output must make that distinction visible.

## Conditional refresh

`recommend_jobs` may refresh jobs, but it must not perform source discovery or catalog expansion.

- `auto` is the default. Refresh when the snapshot is missing or stale, or when fewer than `minimumMatches` qualifying jobs remain after hard filtering.
- `never` guarantees zero network requests and uses the available local snapshot.
- `always` refreshes the relevant verified crawl scope before matching.
- A recommendation call performs at most one crawl and one rematch.
- The crawl is scoped to relevant verified sources, usually the requested country cohort.
- Refresh failures are reported by source; successful partitions still produce recommendations.

If refreshing still produces too few matches, return the best available jobs and explain the shortfall. Never loop indefinitely or broaden geographic intent silently.

## Resume optimization policy

Optimization is job-specific and evidence-grounded. It may:

- Move relevant existing achievements earlier.
- Tighten or clarify supported bullets.
- Surface skills demonstrated in experience but omitted from the skills section.
- Recommend job terminology when the resume already supports the underlying claim.
- Identify unsupported requirements as preparation gaps.

It may not:

- Invent experience, metrics, dates, employers, skills, certifications, education, or authorization.
- Add a job keyword with no supporting evidence.
- conceal a material gap.
- overwrite the user's source resume.
- generate or submit an application without explicit human review outside Openings.

## Privacy and security

- MCP tools accept resume content, not arbitrary filesystem paths.
- Resume content is processed in memory and discarded after the call.
- Resume text and derived profiles are never logged or written into persistent Openings data.
- Resume content is never sent to ATS providers; crawling requires only verified source information.
- Error messages and telemetry must not include resume excerpts.
- Proxy credentials, if users configure a proxy externally, must never appear in reports or logs.

## Explicit non-goals for v1

- No automatic application submission.
- No hosted accounts, resume uploads, or Openings backend.
- No source discovery during a recommendation request.
- No centralized or distributed crawl aggregation; this is parked for v2.
- No unbounded request-time source expansion or arbitrary website crawling.
- No LinkedIn, Indeed, or arbitrary career-page HTML scraping.
- No Openings-hosted LLM, model selection, or required model API key.
- No unexplained proprietary ranking model.
- No cover-letter generation in the v1 critical path.

## Success criteria

V1 is successful when:

1. An MCP user can provide a text or Markdown resume and explicit job intent in one conversation and receive an explained shortlist without using the CLI.
2. Every recommended job passes the user's hard geographic and work-mode constraints.
3. `refresh: auto` performs no more than one relevant crawl and improves or honestly reports the available shortlist.
4. Every fit claim and resume suggestion is traceable to resume evidence or the selected job description.
5. Unsupported requirements are shown as gaps; fabricated resume claims in acceptance tests remain zero.
6. `refresh: never` and offline recommendation tests make zero network calls.
7. Resume content does not appear in snapshots, registries, reports, logs, or persisted test artifacts.
8. MCP exposes no application-submission path and resume optimization never overwrites the input.
9. Every evidence span passes an exact substring-and-offset validation against the normalized resume supplied in the same call.
10. Adversarial resumes cannot cause an absent skill, employer, credential, date, metric, or outcome to appear as a fact.

Candidate-profile parsing is a trust-boundary module. Its acceptance suite must emphasize negative and adversarial behavior alongside positive extraction: absent skills remain absent, instructions embedded in resume prose are treated as resume text rather than trusted commands, unsupported claims cannot be smuggled through nearby wording, malformed evidence offsets fail closed, and no inference is accepted as factual evidence. Tests exercise the public parsing interface and assert both extracted facts and prohibited facts, not merely schema shape.

## Delivery sequence

Shipped v1 core:

1. Candidate-profile schema and text/Markdown resume parsing.
2. Explainable matching against an offline snapshot.
3. `recommend_jobs` as the single-call tracer-bullet workflow.
4. Conditional refresh and one-time rematching.
5. `analyze_job_fit` for a selected job.
6. `optimize_resume` suggestions and unified diffs.

Next delivery sequence:

1. Candidate-driven hidden-job exploration that reuses the existing evidence matcher.
2. Bounded source expansion based on measured coverage gaps.
3. Native local PDF/DOCX extraction only if host-side extraction proves insufficient.

The deterministic `coverage report --country CODE` maintainer command is shipped. It measures global verified/indexed totals, country-cohort discovery provenance, job-level country eligibility, eligible employers, latest rotation-batch success, provider and eligibility-confidence distributions, discovery yield, and actionable partition freshness without network access.

The first tracer bullet is complete when a user supplies a Markdown resume plus India/backend intent and receives five explained matches from an existing offline snapshot through one MCP call.

## Bounded source and job expansion

The authoritative company-domain campaign may enrich unresolved ATS leads, verify new sources, and grow country coverage now that the v1 recommendation experience is usable. Expansion runs outside recommendation calls and preserves the same identity and job-level eligibility gates.

The repository includes `data/companies-career-page.md` as an India-focused discovery asset. It contains company and career-page leads, not verified sources or authoritative company-domain evidence: most URLs are human-facing career pages, some are stale or third-party job-site links, and only a small number directly identify a supported ATS endpoint.

Campaigns import this file into normalized generated seeds while retaining original company name, career URL, source attribution, and campaign provenance. Company-owned career URLs may be used for safe redirect tracing or structured-provider discovery; third-party URLs may suggest a company name but must not establish source identity. Every resulting ATS source must still pass the existing identity, reachability, and job-level eligibility pipeline. Openings must not extract jobs from the linked HTML pages.

Local crawls use source-partition caching and bounded rotation: never-crawled sources first, then the oldest expired partitions. Fresh partitions are skipped, and failed refreshes preserve prior jobs while reporting the failure for a later retry. Optional proxy or managed-fetch transports may be added behind the fetch boundary, but correctness must not depend on proxy rotation.

## Parked v2 work

### Distributed aggregation

Allow multiple user-controlled PCs to crawl assigned verified source partitions and contribute normalized, signed, content-addressed job partitions to a central repository. The aggregator must validate schema, catalog membership, timestamps, checksums, replay protection, and provenance. It must never receive resumes, credentials, or application data.
