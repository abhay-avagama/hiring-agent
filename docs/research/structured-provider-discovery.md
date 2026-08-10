# Structured Provider And Discovery Research

Date: 2026-08-10

## Decision

Retain Greenhouse, Lever, and Ashby. Prototype adapters next for Recruitee and Personio, then SmartRecruiters. Treat Workable as a high-yield experimental provider until its unauthenticated account feed has a documented stability/usage contract. Do not add Freshteam, Darwinbox, Zoho Recruit, BambooHR, or Workday under the current no-HTML/no-required-key rules.

This provider set is broad enough to begin a 1,000-source country-focused campaign. Discovery results are candidates only; every token must pass provider-specific reachability, identity, and payload verification before automatic inclusion.

## Provider Matrix

| Provider | Public structured job source | Authentication | Discovery token | Geography value | Decision |
|---|---|---:|---|---|---|
| Greenhouse | `GET boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | None for reads | Board URL token | Location, offices, description | Keep; primary |
| Lever | `GET api.lever.co/v0/postings/{site}?mode=json` plus EU host | None for reads | Hosted site name | Location and workplace type | Keep; primary |
| Ashby | `GET api.ashbyhq.com/posting-api/job-board/{name}` | None | Job-board name | Primary/secondary structured locations, remote flag | Keep; primary |
| Recruitee | `GET {company}.recruitee.com/api/offers/` | None for Careers Site API | Careers subdomain | Multiple locations and offer fields | Add next |
| Personio | `GET {company}.jobs.personio.de/xml?language=en` | Public career XML observed; current docs also display integration headers | Career subdomain | Structured XML location fields | Prototype next; verify header-free behavior per source |
| SmartRecruiters | `GET api.smartrecruiters.com/v1/companies/{id}/postings` | Endpoint works without a key; overview says Posting API supports API-key auth | Career-site company identifier | Country/region/city and detail reference | Prototype after Recruitee; quarantine if auth behavior changes |
| Workable | `GET workable.com/api/accounts/{account}?details=true` | None observed | `apply.workable.com/{account}` token | Rich job payloads | Experimental: excellent yield, but feed is not documented in current public API docs |
| Freshteam | Career pages are public HTML; tested `/api/job_postings` and `/api/jobs` return 401 | Required for documented API | Freshteam subdomain | Good human-facing location data | Exclude: would require HTML extraction or credentials |
| Darwinbox | Documented Jobs API v3 | API key plus Basic/OAuth | Tenant subdomain | Potentially strong India coverage | Exclude: privileged, request-only API |
| Zoho Recruit | Documented Recruit API | OAuth | Organization/account | Potentially strong India coverage | Exclude: credentialed API; no verified public job feed |
| BambooHR | Documented API | OAuth or API key | Company domain | Unknown public-job coverage | Exclude: credentialed API |
| Workday | Public career sites exist, but no documented unauthenticated external-career job feed was established | Tenant credentials for documented APIs | Tenant/site pair | Rich but portal-specific | Exclude: would depend on undocumented portal calls or HTML extraction |

## Primary Documentation

- [Greenhouse Job Board API](https://developer.greenhouse.io/job-board.html) documents unauthenticated job-list reads and the `content=true` payload.
- [Lever Postings API](https://github.com/lever/postings-api) documents public JSON listings, site names, pagination, and global/EU instances.
- [Ashby Public Job Postings API](https://developers.ashbyhq.com/docs/public-job-posting-api) documents the keyless board endpoint and structured primary/secondary locations.
- [Recruitee Careers Site API](https://docs.recruitee.com/reference/offers) documents the public offers endpoint; its separate ATS API requires authentication.
- [Personio career XML feed](https://developer.personio.de/v1.0/reference/get_xml) documents the per-company external-career feed.
- [SmartRecruiters Posting endpoints](https://developers.smartrecruiters.com/docs/endpoints) document company-scoped listing/detail routes and country/city filters. Its [overview](https://developers.smartrecruiters.com/docs/posting-api) says API-key authentication is supported, creating a contract ambiguity despite successful anonymous probes.
- [Workable developer portal](https://www.workable.com/developers) promotes an API, but its documented account API uses access tokens. The observed anonymous account feed is therefore not yet a trusted contract.
- [Darwinbox API documentation](https://api-docs.darwinbox.com/) says access is privileged/request-only and its job-list endpoint requires credentials.
- [Freshteam API](https://developers.freshteam.com/api/), [Zoho Recruit API](https://www.zoho.com/recruit/developer-guide/apiv2/get-org-data.html), and [BambooHR API](https://documentation.bamboohr.com/docs/getting-started) require credentials for their documented interfaces.

## Endpoint Probes

Representative probes were performed without cookies or credentials:

- SmartRecruiters `BoschGroup`: HTTP 200 JSON, 4,753 postings reported.
- Recruitee `jobs`: HTTP 200 JSON from `/api/offers/`, about 251 KB.
- Personio `personio`: HTTP 200 XML from `/xml?language=en`.
- Workable: 7/7 active India-discovered account tokens returned HTTP 200 JSON; payloads contained 4–889 jobs per account.
- Freshteam `digitap`: human careers page returned HTML; `/api/job_postings` and `/api/jobs` returned HTTP 401 JSON.

These are compatibility observations, not substitutes for documented contracts. Automated verification must be able to disable a provider when its auth or payload behavior changes.

## Country-Focused Discovery Yield Sample

Search-result samples were intentionally small and independently probed where possible; counts below are lower bounds, not market estimates.

| Domain family | Distinct India-relevant company tokens observed | Signal |
|---|---:|---|
| Greenhouse | 11+ | Strong across global tech, finance, security, and data companies |
| Ashby | 7+ | Strong for startups and modern global tech companies |
| Workable | 10+ | Very strong for India-headquartered firms, consultancies, and global employers; 7 active tokens probed successfully |
| Freshteam | 10+ | Very strong India yield, but unusable without HTML extraction or credentials |
| Lever | 6+ across Bengaluru/Pune samples | Useful complementary coverage |
| SmartRecruiters | 5+ in a small sample | Large employers and global capability centers; anonymous endpoint needs contract monitoring |

Examples included India roles at Coinbase, Graviton, Zapier, Notion, Sarvam, Entrata, Acceldata, Actian, Grab, MindTickle, Caxton, Accellor, Exponent Energy, and others. Search-index age is irrelevant to inclusion because verification fetches the current structured source.

## Discovery Channels And Order

1. **ATS-domain search queries**: provider domain × country/city aliases × broad role terms. Extract tokens from result URLs, not job HTML.
2. **Career-page redirect resolution**: follow HTTP redirects and recognize supported ATS hosts. Do not parse arbitrary career-page bodies for jobs.
3. **Provider showcases/directories**: candidate tokens only; independently verify.
4. **Community submissions**: accept company/career/source URLs into a candidate queue, never directly into the verified catalog.
5. **Public datasets and repository search**: extract ATS URLs as candidates, retain dataset/repository provenance, and independently verify.
6. **Optional search API**: accelerates #1 when a maintainer supplies a key; discovery remains operable through submitted/static candidates without it.

## Verification Requirements Discovered

Provider adapters should expose two separate operations:

- `verifySource`: fetch board/account identity plus a bounded sample, prove provider and token validity, and return canonical display name and source metadata.
- `fetchJobs`: retrieve all current jobs with pagination/detail expansion as needed.

Verification must record discovery channel, discovery query or submitted URL, provider, token, canonical source URL, observed company name, checked time, payload version/content type, and outcome. Provider-specific identity evidence differs: Greenhouse exposes board metadata, Workable and Recruitee expose account/company names, while other providers may require job URL/domain consistency.

## Risks And Follow-ups

- Search-result discovery has recall and freshness bias; measure verified yield per query family rather than trusting result counts.
- Workable and SmartRecruiters need a contract-change probe because observed anonymous behavior is less clear than Greenhouse/Lever/Ashby/Recruitee.
- Personio is XML, multilingual, and documentation currently shows headers even though the career feed was anonymously reachable; capture fixtures before committing the adapter.
- Provider identity and duplicate-company resolution are the next design problem (#6).
- Country classification across structured fields and descriptions remains separate (#7).
