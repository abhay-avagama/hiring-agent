---
name: openings
description: Use the MCP-native recommendation tool to find evidence-grounded jobs; legacy local tailoring remains only until optimize_resume ships.
---

# Openings

> **Transitional workflow:** `recommend_jobs` is the sole recommendation and matching implementation. The local tailoring section remains legacy-only until `optimize_resume` ships. Do not reproduce parsing, matching, fit classification, or evidence validation in this skill.

Use `recommend_jobs` for resume-based discovery, `analyze_job_fit` for evidence-grounded analysis of a selected job, and `get_job` for its complete description. Keep `search_jobs` for direct lower-level searches that do not need resume matching. These tools are read-only and must never be used to submit an application.

## Search

1. Ask only for missing constraints that materially change the recommendation.
2. Supply the user's resume content and explicit intent to `recommend_jobs`; never pass an arbitrary filesystem path.
3. Present the returned shortlist, assumptions, evidence, gaps, refresh status, and failures without recalculating fit.
4. Call `analyze_job_fit` before explaining a selected role's fit; present its evidence and gaps without independently recalculating them.
5. Call `get_job` before discussing the complete description of a selected role.

## Tailor an application

Read the user's `resume.md` and `voice.md` from the path they provide or the current workspace. If either is absent, say which input is missing. Do not silently replace `voice.md` with a generic tone.

Create a tailored resume as a clear diff or a separate local Markdown file. Reorder and re-emphasize only facts already supported by `resume.md`; never invent employers, dates, skills, metrics, credentials, or outcomes.

Draft a cover letter only when there is at least one real, role-specific connection traceable to `resume.md` or explicitly supplied by the user. The connection must be something this applicant can uniquely and truthfully say about this role. If none exists, stop and explain the gap instead of generating generic prose.

Infer sentence rhythm, vocabulary, directness, and structure from the raw samples in `voice.md`. Do not use a house template or offer tone presets. Preserve the applicant's meaning and avoid copying confidential material that is unrelated to the application.

End by asking the user to read, verify, and edit every claim. Never navigate to a submission flow, fill an application form, or press submit.
