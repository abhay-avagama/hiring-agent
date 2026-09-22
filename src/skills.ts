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
 */
const VOCABULARY = [
  // languages
  "java", "python", "javascript", "typescript", "golang", "ruby", "php", "scala", "kotlin", "swift", "rust",
  "perl", "matlab", "c++", "c#", "objective c", "dart", "elixir", "haskell", "groovy", "sql", "plsql", "pl sql",
  // web and frontend
  "react", "angular", "vue", "svelte", "next.js", "redux", "jquery", "html", "css", "sass", "tailwind",
  "webpack", "bootstrap", "wordpress", "shopify",
  // mobile
  "android", "ios", "react native", "flutter", "swiftui", "jetpack compose", "xcode", "ionic", "cordova", "xamarin",
  // backend
  "node.js", "express", "django", "flask", "fastapi", "spring", "spring boot", "hibernate", "laravel", "rails",
  "asp.net", "graphql", "grpc", "microservices", "kafka", "rabbitmq", "celery", "websocket",
  // data
  "mysql", "postgresql", "postgres", "mongodb", "cassandra", "redis", "elasticsearch", "snowflake", "databricks",
  "hadoop", "spark", "hive", "airflow", "etl", "dbt", "tableau", "power bi", "looker", "bigquery", "redshift",
  "data warehouse", "data pipeline",
  // machine learning
  "machine learning", "deep learning", "tensorflow", "pytorch", "keras", "nlp", "computer vision", "llm",
  "generative ai", "huggingface", "scikit", "pandas", "numpy", "opencv", "mlops",
  // cloud and infrastructure
  "aws", "azure", "gcp", "kubernetes", "docker", "terraform", "ansible", "jenkins", "gitlab", "github",
  "ci cd", "cicd", "helm", "prometheus", "grafana", "datadog", "splunk", "linux", "nginx", "openshift",
  "cloudformation", "serverless", "devops", "kibana",
  // testing
  "selenium", "cypress", "playwright", "appium", "junit", "testng", "pytest", "jmeter", "postman",
  "test automation", "automation testing",
  // security
  "owasp", "penetration testing", "cryptography", "iam", "soc 2",
  // embedded and hardware
  "embedded", "rtos", "verilog", "vhdl", "firmware", "autosar", "fpga", "plc",
  // enterprise platforms
  "sap", "abap", "salesforce", "servicenow", "sharepoint", "mulesoft", "sapui5",
  // practice
  "agile", "scrum", "jira", "git", "kubernetes", "figma",
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
export function extractSkills(text: string): string {
  if (!text) return "";
  const tokens = searchTokens(text);
  const hits = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (UNIGRAMS.has(token)) hits.add(token);
    const next = tokens[index + 1];
    if (next !== undefined && BIGRAMS.has(`${token} ${next}`)) { hits.add(token); hits.add(next); }
  }
  return [...hits].join(" ");
}
