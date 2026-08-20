export type TransferabilityKind = "backend_programming" | "frontend_programming" | "data_engineering" | "cloud_infrastructure";

interface RequirementDefinition {
  canonical: string;
  display: string;
  aliases?: string[];
  evidence: "exact_skill" | "fact_phrase";
  matching?: { caseSensitive?: boolean; excludedPhrases?: string[]; excludedPatterns?: string[] };
}

interface TransferabilityEdge {
  target: string;
  sources: string[];
  via: TransferabilityKind;
  rationale: string;
}

const requirementDefinitions: RequirementDefinition[] = [
  ...exactSkills([["java", "Java"]]),
  exactSkill("go", "Go", undefined, { caseSensitive: true, excludedPhrases: ["go-to-market", "go-live", "on-the-go"] }),
  ...exactSkills([
    ["golang", "Golang"], ["python", "Python"], ["ruby", "Ruby"], ["node.js", "Node.js"],
    ["postgresql", "PostgreSQL"], ["sql", "SQL"], ["javascript", "JavaScript"], ["typescript", "TypeScript"], ["react", "React"],
    ["vue", "Vue"], ["angular", "Angular"], ["spark", "Spark"], ["hadoop", "Hadoop"], ["dbt", "dbt"], ["airflow", "Airflow"],
    ["snowflake", "Snowflake"], ["aws", "AWS"], ["azure", "Azure"], ["gcp", "GCP"], ["kubernetes", "Kubernetes"],
    ["docker", "Docker"], ["terraform", "Terraform"], ["kafka", "Kafka"], ["databricks", "Databricks"], ["redis", "Redis"],
    ["mongodb", "MongoDB"], ["linux", "Linux"], ["nosql", "NoSQL"], ["c++", "C++"], ["machine learning", "Machine learning"],
    ["jenkins", "Jenkins"], ["spring boot", "Spring Boot"],
  ]),
  exactSkill("spring", "Spring", undefined, {
    excludedPatterns: [String.raw`\bspring(?:\s*[/,&-]\s*(?:fall|summer|winter))*\s+(?:semester\s+)?(?:19|20)\d{2}\b`],
  }),
  exactSkill("ci/cd", "CI/CD", ["continuous integration and continuous delivery", "continuous integration/continuous delivery"]),
  exactSkill("llm", "LLM", ["large language model", "large language models"]),
  phrase("financial products", "Financial products"),
  phrase("data warehouses", "Data warehouses", ["data warehouse"]),
  phrase("etl pipelines", "ETL pipelines", ["etl pipeline"]),
  phrase("high-volume messaging", "High-volume messaging"),
  phrase("streaming platforms", "Streaming platforms", ["streaming platform"]),
  phrase("transaction processing", "Transaction processing", ["transaction-processing"]),
  phrase("restful services", "RESTful services"),
  phrase("microservices", "Microservices"),
];

// Empty by default. Every future edge requires a durable rationale and public-behavior tests.
const transferabilityEdges: TransferabilityEdge[] = [];

const definitionsByCanonical = new Map(requirementDefinitions.map((definition) => [definition.canonical, definition]));

export function detectRequirementTerms(value: string): string[] {
  const occurrences = requirementDefinitions.flatMap((definition) => matchingTerms(definition).flatMap((term) => findOccurrences(value, term, definition)));
  const accepted: typeof occurrences = [];
  for (const occurrence of occurrences.sort((left, right) => right.length - left.length || left.start - right.start)) {
    if (!accepted.some((candidate) => occurrence.start < candidate.end && occurrence.end > candidate.start)) accepted.push(occurrence);
  }
  const matched = new Set(accepted.map((occurrence) => occurrence.definition.canonical));
  return requirementDefinitions.filter((definition) => matched.has(definition.canonical)).map((definition) => definition.display);
}

export function matchesExactSkillEvidence(requirement: string, skill: string): boolean {
  const definition = definitionsByCanonical.get(requirement.toLocaleLowerCase());
  if (definition?.evidence !== "exact_skill") return false;
  const normalized = skill.trim().toLocaleLowerCase();
  return [definition.canonical, definition.display, ...(definition.aliases ?? [])].some((value) => value.toLocaleLowerCase() === normalized);
}

export function requiresExactSkillEvidence(requirement: string): boolean {
  return definitionsByCanonical.get(requirement.toLocaleLowerCase())?.evidence === "exact_skill";
}

export function findTransferability(requirement: string, skills: Array<{ id: string; value: string }>): { via: TransferabilityKind; factIds: string[] } | undefined {
  const edge = transferabilityEdges.find((candidate) => candidate.target === requirement.toLocaleLowerCase());
  if (!edge) return undefined;
  const facts = skills.filter((skill) => edge.sources.includes(skill.value.toLocaleLowerCase()));
  return facts.length ? { via: edge.via, factIds: facts.map((fact) => fact.id) } : undefined;
}

function exactSkills(values: Array<[canonical: string, display: string]>): RequirementDefinition[] {
  return values.map(([canonical, display]) => ({ canonical, display, evidence: "exact_skill" }));
}

function exactSkill(canonical: string, display: string, aliases?: string[], matching?: RequirementDefinition["matching"]): RequirementDefinition {
  return { canonical, display, aliases, evidence: "exact_skill", matching };
}

function phrase(canonical: string, display: string, aliases?: string[]): RequirementDefinition {
  return { canonical, display, aliases, evidence: "fact_phrase" };
}

function matchingTerms(definition: RequirementDefinition): string[] {
  const base = definition.matching?.caseSensitive ? [definition.display, ...(definition.aliases ?? [])] : [definition.canonical, ...(definition.aliases ?? [])];
  return [...new Set(base.flatMap((term) => [term, term.replace(/-/gu, " "), term.replace(/ /gu, "-")]))];
}

function findOccurrences(value: string, term: string, definition: RequirementDefinition): Array<{ definition: RequirementDefinition; start: number; end: number; length: number }> {
  let searchable = value;
  for (const excluded of definition.matching?.excludedPhrases ?? []) searchable = maskMatches(searchable, new RegExp(escapeRegex(excluded), "giu"));
  for (const pattern of definition.matching?.excludedPatterns ?? []) searchable = maskMatches(searchable, new RegExp(pattern, "giu"));
  const escaped = escapeRegex(term);
  const flags = definition.matching?.caseSensitive ? "gu" : "giu";
  const matches = searchable.matchAll(new RegExp(`(^|[^a-z0-9+#])(${escaped})(?=$|[^a-z0-9+#])`, flags));
  return [...matches].map((match) => {
    const start = match.index + match[1]!.length;
    const end = start + match[2]!.length;
    return { definition, start, end, length: end - start };
  });
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
function maskMatches(value: string, pattern: RegExp): string { return value.replace(pattern, (match) => " ".repeat(match.length)); }
