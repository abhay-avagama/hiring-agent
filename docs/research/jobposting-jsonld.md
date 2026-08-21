# Company-owned `JobPosting` JSON-LD research

Date: 2026-08-21

## Decision

Proceed only to a bounded, read-only capability probe. Do not add JSON-LD jobs to the catalog or snapshot yet.

`JobPosting` JSON-LD is a credible sixth source class for employers without a supported ATS, but it is an explicit, narrow exception to the current no-HTML rule. Openings would fetch an HTML container and extract only JSON values from `<script type="application/ld+json">`; it would not read surrounding prose, follow page links, execute JavaScript, render a DOM, or infer jobs from arbitrary markup.

The source is company-owned structured publication, not independently verified truth. Company-domain ownership, safe retrieval, schema validity, currentness, and stable identity must all pass separately.

## What the standards establish

- Schema.org defines `JobPosting` fields for the posting, organization, location, remote eligibility, dates, and identifiers. It does not guarantee that publishers populate them consistently: [Schema.org `JobPosting`](https://schema.org/JobPosting).
- Google requires structured data on the most specific single-job page, not a listing/search page. It requires `datePosted`, `description`, and location information, recommends canonical job URLs in sitemaps, and requires publishers to remove or expire closed jobs: [Google JobPosting documentation](https://developers.google.com/search/docs/appearance/structured-data/job-posting).
- Google recommends sitemaps for full-site coverage and accurate `lastmod` values. Sitemaps are therefore the only approved URL-discovery input for the probe; the crawler must not traverse career-page links: [Google sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).
- Openings must honor the Robots Exclusion Protocol before fetching sitemap or job URLs: [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html).

## Trust and admission model

An authoritative company seed supplies `companyName` and `companyDomain`. A JSON-LD source can belong to that company only when:

1. Every requested URL uses HTTPS on the exact normalized company domain or its subdomain. Redirects must remain inside that boundary.
2. DNS is resolved and pinned for every request and redirect; any private, loopback, link-local, reserved, mixed-public/private, or non-HTTPS destination fails closed.
3. The page contains one syntactically valid object whose `@type` includes `JobPosting`.
4. `hiringOrganization.sameAs`, when present, resolves to the exact normalized company domain or its subdomain. A conflicting domain rejects the item. Name similarity never proves ownership.
5. The record contains a non-empty `title`, complete `description`, valid `datePosted`, `hiringOrganization.name`, and either a physical `jobLocation.address.addressCountry` or a remote `applicantLocationRequirements` country.
6. The record has a stable identity: prefer `identifier.value` namespaced by company domain; otherwise use the canonical same-domain detail URL. A title or description hash is not a stable job identity.
7. `validThrough` in the past rejects the job. When it is absent, the job remains eligible only while a bounded refresh still finds the same `JobPosting`; it inherits the normal 14-day freshness window and disappears after a successful refresh no longer returns it.
8. A company with an existing verified ATS source is excluded from JSON-LD admission in v1. The verified ATS partition wins, avoiding two ingestion paths for the same employer.

The structured `description` may feed the existing deterministic requirement and eligibility classifiers, just as provider descriptions do. Explicit `jobLocation`, `jobLocationType`, and `applicantLocationRequirements` fields take precedence. Generic “global” prose does not create worldwide eligibility.

## Retrieval boundary

The future transport must be a hardened, size-bounded GET sibling of `fetchSafeHead`, not ordinary `fetch`:

- HTTPS port 443 only; no credentials, cookies, request bodies, or caller-controlled headers.
- Resolve and pin a public address before every hop; maximum three same-company redirects.
- Fetch `/robots.txt` for each company-owned origin before requesting a sitemap or detail URL on that origin, and honor rules for an `Openings` user agent. A disallowed sitemap or detail URL is not requested. Redirects are restricted to the request's original origin so they cannot cross into an origin whose policy has not yet been checked.
- Discover only XML sitemap locations declared by `robots.txt` or the conventional same-domain `/sitemap.xml`. Accept at most two sitemap-index levels and only same-company HTTPS URLs. Reject DTDs and entity declarations; never resolve external XML entities.
- Accept XML sitemap and `text/html` responses only. Cap compressed and decoded bodies at 2 MiB; abort on overflow or 15 seconds.
- Parse only sitemap URL entries and JSON-LD script bodies. Do not traverse HTML anchors, execute scripts, resolve JSON-LD remote contexts, load images, styles, or subresources, or inspect surrounding text.
- Treat every JSON-LD string as untrusted data. It may be indexed and matched, but never interpreted as an instruction.

## Canonicalization and deduplication

The source key is `jsonld:{normalized-company-domain}`. The job key is `jsonld:{source-slug}:{identifier}` when a non-empty identifier exists, otherwise the normalized fetched detail URL (or a same-domain JSON-LD `url` value). Strip fragments and default ports; preserve meaningful path/query components rather than guessing tracking parameters. The probe does not parse an HTML canonical-link element.

Within a source, equal identifiers or canonical URLs collapse deterministically. Conflicting records with the same key are quarantined for that refresh instead of selecting one by input order. Cross-source admission is prevented initially by excluding companies already represented by a verified ATS source.

## Bounded capability probe contract

This contract must be approved before the first HTML GET. The probe is read-only and writes only a versioned report under `.openings/`; it cannot modify candidates, registries, catalog, or snapshots.

### Input and caps

- Use at most 20 authoritative company identities from `data/companies-career-page.md` that have no verified ATS source. The report must record the exact ordered company names, normalized domains, and input references so the sample is reproducible.
- Examine the first ten identities, review the health gate, then at most ten more.
- Per company: one robots request per encountered company-owned origin, one conventional sitemap request when the seed origin's robots file declares none, at most five sitemap documents across two index levels, and at most ten candidate detail pages. Every robots request consumes the unchanged global request ceiling.
- Global maximum: 20 companies, 100 sitemap documents, 200 detail pages, and 320 HTTP requests including redirects.
- Concurrency: three companies, one active request per company, at least 500 ms between starts on the same domain, 15-second request timeout, no retry in the probe.

### Success gate

The mechanism is viable for an implementation proposal only if all are true:

- at least 5 of 20 companies expose at least one conforming current `JobPosting`;
- at least 20 distinct current jobs pass the required-field and ownership checks;
- at least 80% of accepted jobs publish a non-empty `identifier.value` rather than relying on URL-only identity;
- at least 95% of accepted jobs have explicit country eligibility from structured fields;
- no request violates the SSRF, redirect, robots, or body-size boundary.

### Stop conditions

Stop immediately on any safety-boundary violation or unexpected write. Stop after the first ten companies if fewer than two yield a conforming job, more than 10% of attempted requests fail due to throttling/transport errors, or more than half of discovered JSON-LD job objects lack a required admission field. Stop when any declared cap is reached; changing a cap requires a newly reviewed contract.

## Unresolved after research

The probe must measure rather than assume sitemap discovery yield, static-HTML availability versus client-rendered injection, real field completeness, and how often company sites duplicate a supported ATS behind branded URLs. No production adapter, Common Crawl campaign, or promotion schema should be designed until those measurements exist.

The single-pass probe measures identifier presence, not longitudinal stability. Identifier stability remains unproven until a later approved repeat probe observes the same jobs across refreshes; the first report must not describe the 80% presence gate as evidence of persistence.
