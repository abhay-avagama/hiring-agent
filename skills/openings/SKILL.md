---
name: openings
description: Use MCP-native tools to find, analyze, and truthfully optimize a resume for evidence-grounded jobs.
---

# Openings

Do not reproduce parsing, matching, fit classification, evidence validation, or resume rewriting in this skill. The MCP modules are the sole enforceable implementation.

Use `recommend_jobs` for resume-based discovery, `analyze_job_fit` for evidence-grounded analysis of a selected job, `optimize_resume` for a proposed revision, and `get_job` for its complete description. Keep `search_jobs` for direct lower-level searches that do not need resume matching. These tools are read-only and must never be used to submit an application.

## Search

1. Ask only for missing constraints that materially change the recommendation.
2. Supply the user's resume content and explicit intent to `recommend_jobs`; never pass an arbitrary filesystem path.
3. Present the returned shortlist, assumptions, evidence, gaps, refresh status, and failures without recalculating fit.
4. Call `analyze_job_fit` before explaining a selected role's fit; present its evidence and gaps without independently recalculating them.
5. Call `get_job` before discussing the complete description of a selected role.

## Tailor an application

1. Supply the selected job ID and resume content to `optimize_resume`; never pass an arbitrary filesystem path.
2. Use `suggestions` for review, `unified_diff` for a patch, or `revised_markdown` for complete proposed content.
3. Present the tool's evidence references and unsupported gaps without adding claims or independently rewriting its output.
4. Ask the user to verify every proposed change. Never navigate to a submission flow, fill an application form, or submit an application.
