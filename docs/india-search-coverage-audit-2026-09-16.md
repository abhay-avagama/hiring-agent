# India search coverage — 16 September 2026

Read-only audit of the published country export, not an expansion campaign. No employer boards were contacted, no source was admitted, and no catalog or snapshot was changed.

## Reproduction

Input: `https://openings.avagama.co/v1/snapshot?countries=IN`, downloaded once. Snapshot timestamp and audit reference time: `2026-09-16T14:04:13.573Z`.

Input SHA-256: `eae32fe22293991a2fa365c6edc438581776d1cbb36447c38f6fdad27143dabc`.

Run `bun scripts/audit-search-coverage.ts PATH_TO_SAVED_SNAPSHOT IN`. The default reference time is the snapshot timestamp, not the wall clock. A later download is a different input and need not reproduce these numbers. The downloaded snapshot remains outside git.

## Findings

| Measure | Count |
| --- | ---: |
| India-classified jobs | 62,318 |
| Distinct normalized company labels (not verified employer identities) | 1,154 |
| Missing descriptions | 29,042 |
| Updated within seven days | 13,121 |
| Updated within thirty days (includes seven-day bucket) | 36,394 |
| Older than thirty days | 25,662 |
| Undated | 262 |
| Repeated job IDs / missing titles | 0 / 0 |
| Possible duplicate company/title/location groups | 4,436 |
| Location-only country disagreements requiring review | 290 |

All 5,640 exported partitions have valid timestamps no more than fourteen days old. This does not establish that every job remains open. Country-filtered exports cannot establish missing source coverage; the local catalog was deliberately not joined to a potentially different-generation published snapshot.

Workday contributes 19,611 jobs and Accenture 19,600; together approximately 63% of the India-classified inventory. SmartRecruiters contributes 8,337 and Keka 4,566. More job rows therefore do not necessarily mean more employer breadth.

Missing inline descriptions are concentrated in Workday (19,611), SmartRecruiters (8,337), Workable (740), Lever (347), and Keka (7). This measures the exported search index, not the availability of detail at the provider: selected-job lookup may recover content on demand. It is still a limitation for snapshot-only keyword search and filtering across the entire inventory. Do not infer that a blank exported description means the actual posting has no requirements.

Existing experience metadata records minimums of 0–2 years on 10,594 jobs, 3–5 on 13,975, 6–10 on 7,406, and above ten on 2,297. Another 12,115 carry null (recorded as unstated) and 15,931 have no extraction metadata. These are minimum-experience buckets, not candidate-fit counts or verified extraction completeness. Blank descriptions prevent confirming whether requirements really are unstated.

Title buckets are intentionally narrow and overlapping. Generic titles such as Software Engineer or Application Developer fall outside the backend/frontend labels, so those small buckets must not be read as a shortage of relevant engineering roles. City buckets are an India-focused first-match heuristic, not an exhaustive multi-location breakdown.

## Quality signals before further scale

The 290 location disagreements are review candidates, not automatic rejections: a remote posting can legitimately accept India despite its displayed location. One inspected example is `greenhouse:anteriad:5618241004`, Manager, Client Partnerships, displayed as Remote-US but tagged IN and US. Its India mention says to work with India and US operations teams, not that the applicant may work from India. This deserves a targeted eligibility regression test rather than blanket removal of every disagreement.

Another inspected record, `workday:aristocrat:Regular`, is Technical Project Manager in North Ryde, NSW, AU with IN and AU eligibility, no description, and a URL ending in requisition R0022479. Its `Regular` ID and country enrichment both need an adapter-level investigation; the saved export alone cannot establish where corruption occurred.

The 4,436 same-company/title/location groups may include distinct valid requisitions. Do not merge them automatically. Provider `updatedAt` can be an update date rather than an original posting date; fresh partition timestamps are not newly posted-job evidence.

## Recommended next slices

1. Investigate and fix confirmed eligibility/identity errors with synthetic regression fixtures, then remeasure. Do not bulk-edit the corpus from review signals alone.
2. Measure missing descriptions by provider and recover details through existing supported structured endpoints, under explicit request caps. Nearly 47% of the current India inventory lacks descriptions, limiting useful keyword search and evidence-based matching before any new board is added.
3. Select the next bounded India expansion by missing employer/role/city/experience coverage, counting net-new eligible employers and usable jobs rather than tokens. No campaign is approved or executed by this report.
4. Design new-job notifications separately around first observation, stable IDs and deduplication. Neither snapshot refresh time nor provider update time is sufficient to promise genuinely new jobs.

## MCP improvements accompanying the audit

Plain search is explicitly resume-optional, accepts stated-experience filtering, and returns total/next-offset pagination with deterministic ID tie-breaking. Unknown experience is excluded by default only when an experience filter is requested; callers can include it explicitly. A stated range is not a hiring or fit guarantee. Pagination is not a frozen-snapshot cursor: keep the resolved date window and filters unchanged, and restart after refresh.

This work does not deploy the hosted service, increase the corpus, add notifications, or change provider identity admission rules.
