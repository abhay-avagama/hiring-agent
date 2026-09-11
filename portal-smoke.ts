import { fetchSourceJobs } from "./src/catalog.ts";
import { providerSpec } from "./src/providers.ts";
import type { Company } from "./src/types.ts";
const run = async (company: Company) => {
  const started = Date.now();
  try {
    const jobs = await fetchSourceJobs(company, fetch);
    const india = jobs.filter((job) => job.eligibleCountries.includes("IN")).length;
    const week = jobs.filter((job) => job.updatedAt && Date.now() - Date.parse(job.updatedAt) <= 7 * 86_400_000).length;
    console.log(company.slug, "jobs", jobs.length, "India", india, "7d", week, `${Math.round((Date.now() - started) / 1000)}s`, JSON.stringify({ t: jobs[0]?.title, l: jobs[0]?.location, u: jobs[0]?.url, d: jobs[0]?.updatedAt, desc: jobs[0]?.description.slice(0, 80) }));
  } catch (error) { console.log(company.slug, "error", error instanceof Error ? error.message : error); }
};
await run({ slug: "infosys", name: "Infosys", ats: "infosys", token: "1" });
await run({ slug: "infosys-bpm", name: "Infosys BPM", ats: "infosys", token: "41" });
await run({ slug: "capgemini-india", name: "Capgemini", ats: "capgemini", token: "in-en" });
await run({ slug: "persistent", name: "Persistent Systems", ats: "zwayam", token: "careers.persistent.com/MTYzNDQ=" });
// first pages only for the two big ones
const tcs = providerSpec("tcs")!; const acc = providerSpec("accenture")!;
const get = async (url: string, format: "json" | "text" = "json", init?: { method?: string; body?: string | FormData; headers?: Record<string, string> }) => { const r = await fetch(url, init as RequestInit); if (!r.ok) throw new Error(`HTTP ${r.status}`); return format === "text" ? r.text() : r.json(); };
const tcsBody = JSON.stringify({ jobTitle: null, jobCity: null, jobFunction: null, jobExperience: null, jobSkill: null, pageNumber: "1", userText: "", jobTitleOrder: null, jobCityOrder: null, jobFunctionOrder: null, jobExperienceOrder: null, applyByOrder: null, regular: true, walkin: true });
const tcsPage = tcs.jobsFromBody(await get(tcs.endpoint("en-IN"), "json", { method: "POST", body: tcsBody, headers: { "content-type": "application/json" } })) ?? [];
const tcsJob = tcs.normalize({ slug: "tcs", name: "Tata Consultancy Services", ats: "tcs", token: "en-IN" }, tcsPage[0]!);
console.log("tcs page1", tcsPage.length, JSON.stringify({ t: tcsJob.title, l: tcsJob.location, c: tcsJob.eligibleCountries, u: tcsJob.url }));
const form = new FormData(); for (const [k, v] of Object.entries({ startIndex: "0", maxResultSize: "100", jobKeyword: "", jobCountry: "India", jobLanguage: "en", countrySite: "in-en", sortBy: "1", searchType: "vectorSearch", enableQueryBoost: "true", minScore: "0.6", totalHits: "true", jobFilters: "[]" })) form.append(k, v);
const accPage = acc.jobsFromBody(await get(acc.endpoint("in-en"), "json", { method: "POST", body: form })) ?? [];
const accJob = acc.normalize({ slug: "accenture-india", name: "Accenture", ats: "accenture", token: "in-en" }, accPage[0]!);
console.log("accenture page1", accPage.length, JSON.stringify({ t: accJob.title, l: accJob.location, c: accJob.eligibleCountries, u: accJob.url, d: accJob.updatedAt, desc: accJob.description.slice(0, 120), chars: accJob.description.length }));
