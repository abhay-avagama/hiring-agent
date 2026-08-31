---
name: openings
description: Use MCP-native tools to find, analyze, and truthfully optimize a resume for evidence-grounded jobs.
---

# Openings

Do not reproduce parsing, matching, fit classification, evidence validation, or resume rewriting in this skill. The MCP modules are the sole enforceable implementation.

Use `prepare_job_search` to bootstrap the private local index and set honest country-level expectations before requesting a resume, `get_job_coverage` for later no-network coverage checks, `recommend_jobs` for resume-based discovery, `analyze_job_fit` for evidence-grounded analysis of a selected job, `optimize_resume` for a proposed revision, and `get_job` for its complete description. Keep `search_jobs` for direct lower-level searches that do not need resume matching. These tools must never be used to submit an application; the only local mutation is the job index maintained by setup and refresh.

## Search

1. Ask for the target countries and call `prepare_job_search` before requesting a resume. Explain that first-time setup runs in resumable batches and uses the network only to build a private local job index. While `nextAction` is `call_again`, call the tool again with the same countries and the returned opaque `continuation`; do not ask for a resume between batches. On `retry_later`, disclose failures and offer to continue with the indexed coverage or retry later without the old continuation. On `ready`, present its job-level source, job, and employer counts exactly as returned; never substitute discovery-cohort counts or recalculate coverage.
2. Ask only for missing constraints that materially change the recommendation.
3. Supply the user's resume content, explicit intent, and their chosen `ranking.mode` (`evidence` by default or `keyword`) to `recommend_jobs`; never pass an arbitrary filesystem path. Use `ranking.minimumPercent` only when the user requests a cutoff.
4. Present the returned coverage summary alongside the recommendations without recalculating it.
5. Present direct, hidden title-family, and stretch results separately. For a hidden result, quote the returned title expansions and whether each came from explicit intent or validated resume fact IDs; never invent or broaden an alias in the skill.
6. Present both returned percentages, the selected score, assumptions, evidence, gaps, refresh status, and failures without recalculating fit. Never describe keyword overlap as demonstrated competence.
7. Call `analyze_job_fit` before explaining a selected role's fit; present its evidence and gaps without independently recalculating them.
8. Call `get_job` before discussing the complete description of a selected role.

## Tailor an application

1. Supply the selected job ID and resume content to `optimize_resume`; never pass an arbitrary filesystem path.
2. Use `suggestions` for review, `unified_diff` for a patch, or `revised_markdown` for complete proposed content.
3. Present the tool's evidence references and unsupported gaps without adding claims or independently rewriting its output.
4. Ask the user to verify every proposed change. Never navigate to a submission flow, fill an application form, or submit an application.
