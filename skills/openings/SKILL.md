---
name: openings
description: Legacy transitional workflow for searching jobs and tailoring local application materials. Use only until the MCP-native recommendation and resume-optimization tools replace this flow.
---

# Openings

> **Legacy transitional workflow:** This skill predates the MCP-native v1 workflow specified in `docs/PRD.md`. It remains for backwards compatibility while only `search_jobs` and `get_job` exist. Once `recommend_jobs` and `optimize_resume` ship, replace the parsing, matching, and tailoring instructions below with a thin wrapper around those tools. Do not extend this skill with a second recommendation or resume-optimization implementation.

Use the `search_jobs` and `get_job` tools to discover and inspect openings. These tools are read-only and must never be used to submit an application.

## Search

1. Ask only for missing constraints that materially change the search; otherwise infer them from the conversation.
2. Call `search_jobs` with useful role words, location, and remote preference.
   - Pass the user's two-letter country code (for example, `IN` or `DE`) when country eligibility matters. Add `location` only when they want a particular city; Bangalore/Bengaluru and Gurgaon/Gurugram are treated as equivalents.
3. Present a short, evidence-based shortlist. Do not claim candidate fit until you have read both the full job and the user's resume.
4. Call `get_job` before analyzing or tailoring for a selected role.

## Tailor an application

Read the user's `resume.md` and `voice.md` from the path they provide or the current workspace. If either is absent, say which input is missing. Do not silently replace `voice.md` with a generic tone.

Create a tailored resume as a clear diff or a separate local Markdown file. Reorder and re-emphasize only facts already supported by `resume.md`; never invent employers, dates, skills, metrics, credentials, or outcomes.

Draft a cover letter only when there is at least one real, role-specific connection traceable to `resume.md` or explicitly supplied by the user. The connection must be something this applicant can uniquely and truthfully say about this role. If none exists, stop and explain the gap instead of generating generic prose.

Infer sentence rhythm, vocabulary, directness, and structure from the raw samples in `voice.md`. Do not use a house template or offer tone presets. Preserve the applicant's meaning and avoid copying confidential material that is unrelated to the application.

End by asking the user to read, verify, and edit every claim. Never navigate to a submission flow, fill an application form, or press submit.
