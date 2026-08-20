import { readFile } from "node:fs/promises";
import { isEligibleForCountry } from "../src/locations.ts";
import type { JobSnapshot } from "../src/types.ts";

const snapshotPath = process.argv[2] ?? ".openings/snapshot.json";
const country = (process.argv[3] ?? "IN").toUpperCase();
if (!/^[A-Z]{2}$/u.test(country)) throw new Error("Country must be a two-letter code");

const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as JobSnapshot;
const jobs = Object.values(snapshot.partitions).flatMap((partition) => partition.jobs).filter((job) => isEligibleForCountry(job, country));
const positive = /\b(?:required?|must|need(?:ed)?|minimum|proficien(?:t|cy)|experience (?:in|with)|hands-on|expertise|knowledge of|familiarity with)\b/iu;
const requiredHeading = /^(?:what(?:'|’)s required|required qualifications?|requirements?|qualifications?|minimum qualifications?|essentials?|essential qualifications?|must haves?|your experience includes):?$/iu;
const otherHeading = /^.{1,60}:$/u;
const stopWords = new Set(`the a an and or to of in with for on is are be as at from by you your we our will have has this that years year experience required requirements must need needed minimum proficient proficiency strong solid good excellent ability knowledge familiarity hands hand expertise understanding working work skills skill including plus preferred role team teams using build building develop developing design designing software systems solutions applications technologies technology environment environments engineering engineer development related relevant demonstrated manage support responsible responsibilities candidate candidates degree computer science business`.split(/\s+/u));
const technicalCandidates = [
  "ai", "machine learning", "artificial intelligence", "generative ai", "llm", "nlp", "deep learning", "computer vision",
  "kafka", "graphql", "elasticsearch", "grpc", "rabbitmq", "pulsar", "event-driven", "message queues",
  "rust", "c++", "c#", ".net", "scala", "kotlin", "swift", "golang", "php", "r programming",
  "spring", "spring boot", "django", "flask", "fastapi", "express", "nestjs", "rails", "react native",
  "android", "ios", "pytorch", "tensorflow", "scikit-learn", "pandas", "numpy",
  "jenkins", "github actions", "gitlab ci", "azure devops", "ci/cd", "prometheus", "grafana", "splunk", "datadog",
  "linux", "unix", "bash", "powershell", "ansible", "helm", "openshift", "serverless",
  "oracle", "mysql", "mariadb", "cassandra", "dynamodb", "neo4j", "nosql", "vector database",
  "rest api", "web services", "design patterns", "data structures", "system design",
] as const;
const currentlyRecognized = new Set([
  "java", "go", "golang", "python", "ruby", "node.js", "postgresql", "sql", "javascript", "typescript", "react", "vue", "angular",
  "spark", "hadoop", "dbt", "airflow", "snowflake", "aws", "azure", "gcp", "kubernetes", "docker", "terraform", "financial products",
  "databricks", "data warehouses", "etl pipelines", "high-volume messaging", "streaming platforms", "transaction processing", "restful services",
  "microservices", "redis", "mongodb",
]);

const unigrams = new Map<string, number>();
const bigrams = new Map<string, number>();
const clausesByJob = new Map<string, string[]>();
let requirementClauses = 0;
for (const job of jobs) {
  let inRequiredSection = false;
  for (const line of structuredLines(job.description)) {
    if (requiredHeading.test(line)) { inRequiredSection = true; continue; }
    if (otherHeading.test(line)) inRequiredSection = false;
    for (const clause of line.split(/[.!?;]+/u)) {
      if (!inRequiredSection && !positive.test(clause)) continue;
      requirementClauses += 1;
      const selected = clausesByJob.get(job.id) ?? [];
      selected.push(clause);
      clausesByJob.set(job.id, selected);
      const tokens = (clause.toLocaleLowerCase().match(/[a-z][a-z0-9+#.-]*/gu) ?? [])
        .filter((token) => token.length > 1 && !stopWords.has(token) && !/^\d/u.test(token));
      for (const token of tokens) increment(unigrams, token);
      for (let index = 0; index < tokens.length - 1; index += 1) increment(bigrams, `${tokens[index]} ${tokens[index + 1]}`);
    }
  }
}

console.log(JSON.stringify({
  country,
  snapshotUpdatedAt: snapshot.updatedAt,
  eligibleJobs: jobs.length,
  requirementClauses,
  technicalCandidates: technicalCandidates.map((term) => {
    let mentions = 0;
    let jobs = 0;
    const examples: Array<{ jobId: string; clause: string }> = [];
    for (const [jobId, clauses] of clausesByJob) {
      const count = clauses.reduce((sum, clause) => sum + phraseCount(clause, term), 0);
      mentions += count;
      if (count) {
        jobs += 1;
        const clause = clauses.find((candidate) => phraseCount(candidate, term) > 0);
        if (clause && examples.length < 3) examples.push({ jobId, clause: clause.trim().replace(/\s+/gu, " ").slice(0, 300) });
      }
    }
    return { term, currentlyRecognized: currentlyRecognized.has(term), mentions, jobs, examples };
  }).filter((candidate) => candidate.mentions > 0).sort((left, right) => right.jobs - left.jobs || right.mentions - left.mentions || left.term.localeCompare(right.term)),
  topUnigrams: top(unigrams, 250),
  topBigrams: top(bigrams, 200),
}, null, 2));

function structuredLines(value: string): string[] {
  return value.replace(/<br\s*\/?>/giu, "\n").replace(/<\/(?:p|li|ul|ol|h[1-6])>/giu, "\n")
    .replace(/<[^>]+>/gu, " ").replace(/&nbsp;|&#160;|\u00a0/giu, " ")
    .split("\n").map((line) => line.trim().replace(/\s+/gu, " ")).filter(Boolean);
}

function increment(counts: Map<string, number>, value: string): void { counts.set(value, (counts.get(value) ?? 0) + 1); }
function phraseCount(value: string, phrase: string): number {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return value.match(new RegExp(`(^|[^a-z0-9+#])${escaped}(?=$|[^a-z0-9+#])`, "giu"))?.length ?? 0;
}
function top(counts: Map<string, number>, limit: number): Array<[string, number]> {
  return [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, limit);
}
