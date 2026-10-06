import { expect, test } from "bun:test";
import { describeWatchProfile, toWatchProfile } from "../src/watch-profile.ts";
import type { CandidateProfile } from "../src/candidate-profile.ts";

const profile = (over: Partial<CandidateProfile> = {}): CandidateProfile => ({
  normalizedResume: { text: "SECRET RESUME TEXT", format: "text" } as never,
  facts: [
    { id: "1", kind: "skill", value: "Kubernetes", evidence: [{ start: 0, end: 10, quote: "ran Kubernetes at Acme since 2019" }] },
    { id: "2", kind: "role", value: "Backend Engineer", evidence: [{ start: 0, end: 5, quote: "Backend Engineer at Acme" }] },
    { id: "3", kind: "employer", value: "Acme Corp", evidence: [{ start: 0, end: 5, quote: "Acme Corp, Bengaluru" }] },
    { id: "4", kind: "project_statement", value: "Led the migration of a 40-service estate to Kubernetes over eighteen months", evidence: [] },
  ],
  inferences: [
    { kind: "seniority", value: "senior", derivedFromFactIds: ["2"] },
    { kind: "approximate_experience_years", value: 7, derivedFromFactIds: ["3"] },
  ],
  ...over,
});

test("a stored monitor keeps the search, never the resume", () => {
  const watch = toWatchProfile(profile(), { countries: ["in"], locations: ["Bengaluru"] });
  const serialized = JSON.stringify(watch);
  // Nothing that could reconstruct the document: no quotes, no prose, no employer history.
  expect(serialized).not.toContain("SECRET RESUME TEXT");
  expect(serialized).not.toContain("ran Kubernetes at Acme");
  expect(serialized).not.toContain("Acme");
  expect(serialized).not.toContain("quote");
  expect(watch.skills).toEqual(["kubernetes"]);
  expect(watch.roles).toEqual(["backend engineer"]);
  expect(watch.seniority).toBe("senior");
  expect(watch.approximateYears).toBe(7);
  expect(watch.countries).toEqual(["IN"]);
});

test("a fact long enough to be a sentence is treated as resume text and dropped", () => {
  const watch = toWatchProfile(profile());
  // The project statement is prose about the candidate; keeping it would smuggle the resume in.
  expect(JSON.stringify(watch)).not.toContain("migration");
  expect(watch.skills.every((s) => s.split(" ").length <= 5)).toBe(true);
});

test("a candidate can read back what is held, in plain words", () => {
  const said = describeWatchProfile(toWatchProfile(profile(), { countries: ["IN"], remote: true }));
  expect(said).toContain("backend engineer");
  expect(said).toContain("senior");
  expect(said).toContain("7 years");
  expect(said).toContain("remote only");
});

test("an empty resume yields an empty monitor rather than a wrong one", () => {
  const watch = toWatchProfile({ normalizedResume: { text: "", format: "text" } as never, facts: [], inferences: [] });
  expect(watch.skills).toEqual([]);
  expect(describeWatchProfile(watch)).toContain("no details");
});

import { matchWatch, type WatchableJob, type WatchProfile } from "../src/watch-profile.ts";

const watch: WatchProfile = {
  skills: ["kubernetes", "terraform"], roles: ["backend engineer"], seniority: "senior",
  roleFamilies: ["backend"], approximateYears: 7, countries: ["IN"], locations: [], excludedTerms: ["intern"],
};
const job = (over: Partial<WatchableJob>): WatchableJob => ({
  id: "1", title: "Backend Engineer", company: "Acme", location: "Bengaluru, India",
  remote: false, countries: ["IN"], ...over,
});

test("a monitor explains why each role matched rather than showing a score", () => {
  const [top] = matchWatch(watch, [job({ id: "a", skills: "kubernetes terraform" })]);
  expect(top!.reasons.join(" ")).toContain("the title matches your work");
  expect(top!.reasons.join(" ")).toContain("kubernetes");
});

test("it respects what the candidate ruled out and where they will work", () => {
  const results = matchWatch(watch, [
    job({ id: "intern", title: "Backend Engineer Intern" }),          // excluded by term
    job({ id: "us", title: "Backend Engineer", countries: ["US"] }),  // wrong country
    job({ id: "ok", title: "Backend Engineer" }),
  ]);
  expect(results.map((r) => r.job.id)).toEqual(["ok"]);
});

test("a role far above the candidate's years is not a stretch, it is noise", () => {
  const results = matchWatch(watch, [
    job({ id: "reach", title: "Backend Engineer", experience: { min: 15 } }),
    job({ id: "fair", title: "Backend Engineer", experience: { min: 8 } }),
  ]);
  expect(results.map((r) => r.job.id)).toEqual(["fair"]);
});

test("a role matching nothing the candidate has done is left out", () => {
  expect(matchWatch(watch, [job({ id: "x", title: "Dental Nurse", skills: "" })])).toEqual([]);
});
