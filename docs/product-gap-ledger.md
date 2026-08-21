# Openings product gap ledger

This ledger records the product gaps synthesized after the v1 evidence, coverage, and source-verification work. It separates deliberate trust/privacy constraints from gaps ready for implementation.

## Candidate and matching coverage

| Gap | State | Next decision or action |
| --- | --- | --- |
| Freshers and thin resumes | Open | Design intent- and project-led discovery without manufacturing resume evidence. |
| Career changers | Structural | Add transferability only through individually reviewed edges with durable rationales. |
| Sponsorship needs | Open | Research structured sponsorship signals; never infer them from silence. |
| Non-English inputs | Open | Measure language demand before localized clause and seniority detection. |
| Complex PDF/DOCX layouts | Blocked | Keep host extraction until concrete failures are documented. |
| Requirement vocabulary | Active | Continue audited detection batches; keep transferability separate and empty by default. |
| Soft and domain skills | Open | Design a separate evidence vocabulary rather than forcing them into technology categories. |
| Non-engineering roles | Open | Add role families and requirements only after representative corpus measurement. |

## Geography and corpus

| Gap | State | Next decision or action |
| --- | --- | --- |
| Markets outside India | Active | Choose the next country for a named audience and run a bounded coverage campaign. |
| Employers outside supported ATS providers | Blocked | JSON-LD requires a reviewed same-company origin-transition design. |
| Remote/anywhere eligibility | Open | Reassess against a larger provider-neutral corpus. |
| Provider/company-size skew | Structural | Report it transparently; do not equate source volume with employer breadth. |

## Product and distribution

| Gap | State | Next decision or action |
| --- | --- | --- |
| Human onboarding | Addressed in Phase 0 | Maintain `docs/job-seeker-quickstart.md` and candidate-facing plugin copy. |
| First-run coverage lottery | Partly addressed | Always show job-level coverage before resume collection; improve geography deliberately. |
| Session continuity | Structural | Stateless unless a separate consent and lifecycle decision changes it. |
| Host-dependent error recovery | Blocked | Keep stable structured errors; document recovery for candidates and hosts. |
| Distribution | Blocked on packaging | Compare and build an approved public npm/registry package or local Anthropic MCPB before submission. |
| Candidate-facing pitch | Addressed in Phase 0 | Lead with evidence-grounded hidden-job discovery, not crawler internals. |
| MCP-only front door | Structural | A candidate must already use an MCP-capable host until a separate front-page/app decision is made. |
| Outcome proof | Blocked | Do not retain candidate identity merely to create success metrics. |
| Employer relationship | Open | Employers expose public feeds but have no opt-in, dashboard, candidate access, or promotion incentive. |

## Go-to-market and virality

| Gap | State | Next decision or action |
| --- | --- | --- |
| Public distribution channel | Blocked on packaging | Complete a local-first package and submit it through the chosen reviewed directory path. |
| Shareable result | Open | Gate on the stateless-versus-opt-in-export decision below. |
| Referral loop | Open | Do not introduce identity or tracking before the persistence decision. |
| Hidden-job aha moment is trapped in chat | Open | Consider a candidate-initiated export that preserves evidence and excludes the resume by default. |
| Aggregate trust signal | Later | Publish non-personal source, employer, job, and freshness statistics without accounts. |
| Candidate-facing front page | Later | Build only after positioning, onboarding, and a distribution package are validated. |

## Virality and privacy decision

Shareable results, referrals, and visible success proof create pressure to persist identity or results. Openings currently moves in the opposite direction: resumes are not stored, profiles are not retained, and every session is self-contained.

This must be an explicit product decision. The valid options are:

1. remain fully stateless and distribute through host/plugin placement; or
2. define a narrow, opt-in, candidate-initiated export containing only what the candidate chooses to share.

No referral, share-link, account, saved-profile, or success-counter implementation should precede that decision.

## Sequence

1. **Now:** human onboarding, accurate plugin positioning, directory research, and small composed-response defects.
2. **Near:** vocabulary batch 2, representative non-engineering modeling, and a deliberately selected second geography.
3. **Decision first:** stateless versus opt-in export; JSON-LD origin transitions; native document extraction after evidence of need.
4. **Later:** aggregate non-personal coverage/freshness surface and a candidate-facing front page.
