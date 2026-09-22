/**
 * Skill tokens lifted out of a job description so search can find them.
 *
 * Search matches a job by its title and employer only, which is why a "react native" search returned 78 India
 * roles while 171 more carried the term only in their description. Holding the descriptions themselves in the
 * index is not an option (334 MB across live India and US roles, against 11 MB of titles), so each role keeps
 * the handful of vocabulary terms its description mentions: a few dozen bytes, and none of the boilerplate.
 */
import { searchTokens } from "./text-match.ts";

/**
 * Terms a candidate actually types. Deliberately narrow: a term earns its place by being a technology or
 * practice someone searches for, not by appearing often. Two-word entries match only as adjacent words.
 * Left out on purpose: bare "c", "go" and ".net", which collide with ordinary prose, and employer names such
 * as Oracle and Workday, which would tag every role at that employer.
 *
 * Measured and withdrawn after the first panel run: "data warehouse", "data pipeline", "test automation" and
 * "automation testing" each contributed an ordinary word ("data", "test", "automation") that a candidate types
 * as a modifier, so "data engineer" reached any Software Engineer whose description mentioned a data pipeline.
 * A term whose words a query uses as modifiers cannot come from the description. Gone for the same reason:
 * "express", "spring", "embedded", "plc" and "agile"/"scrum"/"jira", which are ordinary words or boilerplate.
 *
 * The vocabulary holds tools, never the name of a role. "DevOps" and "Android" in a description say the job
 * touches them; a sample of what they reached was support and management roles, not DevOps or Android jobs.
 * A role's own title is the evidence that it is that role, and search ranks a title match above a mention.
 */
const VOCABULARY = [
  // languages
  "java", "python", "javascript", "typescript", "golang", "ruby", "php", "scala", "kotlin", "swift", "rust",
  "perl", "matlab", "c++", "c#", "objective c", "dart", "elixir", "haskell", "groovy", "sql", "plsql", "pl sql",
  // web and frontend
  "react", "angular", "vue", "svelte", "next.js", "redux", "jquery", "html", "css", "sass", "tailwind",
  "webpack", "bootstrap", "wordpress", "shopify",
  // mobile
  "react native", "flutter", "swiftui", "jetpack compose", "xcode", "ionic", "cordova", "xamarin",
  // backend
  "node.js", "django", "flask", "fastapi", "spring boot", "hibernate", "laravel", "rails",
  "asp.net", "graphql", "grpc", "microservices", "kafka", "rabbitmq", "celery", "websocket",
  // data
  "mysql", "postgresql", "postgres", "mongodb", "cassandra", "redis", "elasticsearch", "snowflake", "databricks",
  "hadoop", "spark", "hive", "airflow", "etl", "dbt", "tableau", "power bi", "looker", "bigquery", "redshift",
  
  // machine learning
  "machine learning", "deep learning", "tensorflow", "pytorch", "keras", "nlp", "computer vision", "llm",
  "generative ai", "huggingface", "scikit", "pandas", "numpy", "opencv",
  // cloud and infrastructure
  "aws", "azure", "gcp", "kubernetes", "docker", "terraform", "ansible", "jenkins", "gitlab", "github",
  "ci cd", "cicd", "helm", "prometheus", "grafana", "datadog", "splunk", "linux", "nginx", "openshift",
  "cloudformation", "serverless", "kibana",
  // testing
  "selenium", "cypress", "playwright", "appium", "junit", "testng", "pytest", "jmeter", "postman",
  
  // security
  "owasp", "penetration testing", "cryptography", "iam", "soc 2",
  // embedded and hardware
  "rtos", "verilog", "vhdl", "firmware", "autosar", "fpga", 
  // enterprise platforms
  "sap", "abap", "salesforce", "servicenow", "sharepoint", "mulesoft", "sapui5",
  // practice
  "git", "figma",
] as const;

/** Vocabulary reduced to the same stemmed tokens the matcher produces, so stored terms and queries agree. */
const UNIGRAMS = new Set<string>();
const BIGRAMS = new Set<string>();
for (const term of VOCABULARY) {
  const tokens = searchTokens(term);
  if (tokens.length === 1) UNIGRAMS.add(tokens[0]!);
  else if (tokens.length === 2) BIGRAMS.add(`${tokens[0]} ${tokens[1]}`);
}

/**
 * The vocabulary terms this text mentions, as a space-separated string ready to append to the haystack.
 * Phrases contribute their own words: matching is term by term, so "react native" is stored as both.
 */
/** A term named once is a passing reference; a requirement is restated. The count was measured, not guessed. */
const MENTIONS_REQUIRED = 2;

export function extractSkills(text: string): string {
  if (!text) return "";
  const tokens = searchTokens(text);
  const counts = new Map<string, number>();
  const count = (term: string) => counts.set(term, (counts.get(term) ?? 0) + 1);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (UNIGRAMS.has(token)) count(token);
    const next = tokens[index + 1];
    if (next !== undefined && BIGRAMS.has(`${token} ${next}`)) { count(token); count(next); }
  }
  const hits: string[] = [];
  for (const [term, seen] of counts) if (seen >= MENTIONS_REQUIRED) hits.push(term);
  return hits.join(" ");
}
