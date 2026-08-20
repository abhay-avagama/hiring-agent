# Requirement Vocabulary Audit

Date: `2026-08-20`

## Scope and method

The offline audit used `.openings/snapshot.json` at `2026-08-20T14:11:49.211Z`, selected all 6,905 jobs eligible for `IN` with the shipped eligibility classifier, and inspected 9,396 clauses selected by conservative requirement markers or required-section headings. `scripts/audit-requirement-vocabulary.ts` emits deterministic counts plus example clauses and never modifies the snapshot.

Raw word frequency is not treated as a requirement dictionary. Requirement markers also occur in legal and accommodation prose, and short terms such as `AI` can be contextually broad. The audit therefore measures an explicit technical candidate lexicon, reports distinct-job counts, and retains example clauses for review. Counts establish corpus prevalence; they do not by themselves authorize detection or transferable credit.

## Highest-frequency unrecognized candidates

| Candidate | Distinct jobs | Mentions | Initial interpretation |
| --- | ---: | ---: | --- |
| AI | 206 | 495 | High prevalence but broad; canonicalize with longer AI terms carefully |
| CI/CD | 77 | 81 | High-confidence engineering practice requirement |
| Linux | 46 | 61 | High-confidence platform requirement |
| NoSQL | 43 | 43 | High-confidence database-category requirement |
| C++ | 40 | 43 | High-confidence exact language requirement |
| Kafka | 35 | 44 | High-confidence exact platform requirement |
| LLM | 34 | 43 | High-confidence AI-system requirement when requirement-shaped |
| machine learning | 28 | 36 | High-confidence domain requirement |
| Jenkins | 25 | 25 | High-confidence exact tooling requirement |
| Spring | 19 | 39 | Exact framework requirement; overlaps Spring Boot |
| event-driven | 17 | 17 | Architecture requirement, not a resume skill family |
| generative AI | 16 | 18 | AI-domain requirement; overlaps AI and LLM |
| MySQL | 14 | 16 | High-confidence exact datastore requirement |
| Prometheus | 14 | 14 | High-confidence exact observability requirement |
| Spring Boot | 13 | 17 | Exact framework requirement; prefer longest-alias matching |
| design patterns | 13 | 13 | Engineering-knowledge requirement |
| PyTorch | 13 | 13 | High-confidence exact ML-framework requirement |
| Scala | 12 | 14 | High-confidence exact language requirement |
| web services | 12 | 14 | Broad service-development requirement |
| data structures | 12 | 12 | Engineering-knowledge requirement |
| system design | 12 | 12 | Engineering-knowledge requirement |
| Ansible | 11 | 12 | High-confidence exact automation-tool requirement |
| Grafana | 11 | 11 | High-confidence exact observability requirement |
| TensorFlow | 11 | 11 | High-confidence exact ML-framework requirement |
| Unix | 11 | 11 | High-confidence platform requirement |
| Bash | 10 | 11 | High-confidence exact shell requirement |
| PowerShell | 10 | 11 | High-confidence exact shell requirement |
| GraphQL | 10 | 10 | High-confidence exact API technology requirement |
| NLP | 10 | 10 | AI-domain requirement |
| scikit-learn | 10 | 10 | High-confidence exact ML-framework requirement |

Lower-frequency but clearly present candidates include Splunk, FastAPI, Oracle, C#, Django, MariaDB, Rails, Datadog, iOS, DynamoDB, deep learning, Flask, pandas, Android, RabbitMQ, Elasticsearch, GitHub Actions, Kotlin, NumPy, Swift, and Rust. They should not outrank the table solely because they were named in advance.

## Model decision

Requirement detection and transferable credit must use separate data:

- A detection definition gives a canonical requirement, exact aliases, display name, and optional disambiguation rules. Detection allows the matcher to report exact resume support or a gap.
- Transferability defaults to none. It is granted only by an explicit reviewed relationship from validated resume evidence to a target requirement, with its own tests and rationale.
- Broad families may continue to support title-family exploration, but membership in `backend_programming`, `frontend_programming`, `data_engineering`, or `cloud_infrastructure` must not automatically imply cross-technology requirement credit.
- Longest aliases win before shorter overlapping aliases (`Spring Boot` before `Spring`; `generative AI` before `AI`). Canonical aliases are deduplicated so one clause cannot inflate evidence.
- Ambiguous short forms require targeted negative tests. The recent `Go`/`go-to-market` regression is the minimum standard, not a special case to forget.

A suitable implementation seam is two registries rather than one overloaded map:

1. `requirementDefinitions`: canonical term, aliases, display value, and matching policy.
2. `transferabilityEdges`: explicit source-evidence-to-target relationships; empty unless independently justified.

The first implementation batch should prioritize frequent, exact, low-ambiguity requirements. AI umbrella terms and architectural concepts should land only with canonicalization and negative cases. No matcher behavior should change until that batch and its transferability policy are reviewed together.

## Audit limitations

- Counts are a lower-bound snapshot measurement, not a universal technology taxonomy.
- Provider descriptions vary in structure; requirement-marker selection can include contextual prose and miss unmarked bullet lists.
- Distinct-job counts can include near-duplicate roles across sources or locations.
- The candidate lexicon is explicit and reviewable but not exhaustive. Future audits should add terms based on corpus examples, not intuition alone.
