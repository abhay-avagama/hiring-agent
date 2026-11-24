// How much of a snapshot's India jobs the title rules can place. Coverage, not accuracy: accuracy needs hand labels.
// Run: bun run scripts/facet-coverage.ts [snapshot.json]   (default ~/.openings/snapshot.json)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { jobFacets } from "../src/job-facets.ts";
import type { JobSnapshot } from "../src/types.ts";

const snapshot = JSON.parse(readFileSync(process.argv[2] ?? `${homedir()}/.openings/snapshot.json`, "utf8")) as JobSnapshot;
const jobs = Object.values(snapshot.partitions).flatMap((partition) => partition.jobs).filter((job) => job.eligibleCountries.includes("IN"));
const count = (values: string[]) => [...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
const facets = jobs.map((job) => ({ job, facets: jobFacets(job) }));
const pct = (n: number) => `${(100 * n / jobs.length).toFixed(1)}%`;
const other = facets.filter(({ facets }) => facets.role === "other");
console.log(`${jobs.length} India jobs in ${snapshot.updatedAt}`);
console.log(`role placed (not "other"): ${pct(jobs.length - other.length)}`);
console.log(`seniority known: ${pct(facets.filter(({ facets }) => facets.seniority).length)}`);
console.log(`city found: ${pct(facets.filter(({ facets }) => facets.cities).length)}, state only: ${pct(facets.filter(({ facets }) => !facets.cities && facets.states).length)}`);
console.log("\nroles:", count(facets.map(({ facets }) => facets.role)).map(([k, v]) => `${k} ${v}`).join(", "));
console.log("\nseniority:", count(facets.map(({ facets }) => facets.seniority ?? "unknown")).map(([k, v]) => `${k} ${v}`).join(", "));
console.log("\ncommonest titles left as other:"); for (const [title, n] of count(other.map(({ job }) => job.title.toLowerCase())).slice(0, 25)) console.log(`  ${n}  ${title}`);
console.log("\ncommonest locations with no city:"); for (const [place, n] of count(facets.filter(({ facets }) => !facets.cities).map(({ job }) => job.location)).slice(0, 15)) console.log(`  ${n}  ${place}`);
