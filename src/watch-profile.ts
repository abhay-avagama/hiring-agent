/**
 * The part of a candidate we are willing to remember.
 *
 * A monitor has to persist something or it cannot tell you what is new. Resumes are not that something: the
 * privacy page says a resume is read for one request and never stored, and that promise is the product rather
 * than a detail of it. What survives here is the search the resume produced — the skills, titles, seniority and
 * years that matching actually uses — and never a word of the document itself.
 *
 * Evidence spans are dropped deliberately. They are verbatim quotes from the resume, and keeping them would put
 * the document back in the database through a side door.
 */
import type { CandidateProfile } from "./candidate-profile.ts";

export interface WatchProfile {
  /** Skills named in the resume, lower-cased, with no surrounding text. */
  skills: string[];
  /** Role titles the candidate has held, as written, with no employer or dates attached. */
  roles: string[];
  seniority?: "intern" | "junior" | "mid" | "senior" | "lead" | "staff" | "principal" | "manager";
  roleFamilies: string[];
  /** Years as derived from dated work, not as claimed anywhere in prose. */
  approximateYears?: number;
  /** What the candidate asked for, which is theirs to state rather than ours to infer. */
  countries: string[];
  locations: string[];
  remoteOnly?: boolean;
  excludedTerms: string[];
}

const CAP = 40;
const clean = (values: Iterable<string>, cap = CAP): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim().toLowerCase().slice(0, 64);
    // A fact long enough to be a sentence is a sentence, and a sentence from a resume is resume text.
    if (!value || value.length > 64 || value.split(/\s+/).length > 5 || seen.has(value)) continue;
    seen.add(value); out.push(value);
    if (out.length >= cap) break;
  }
  return out;
};

/** Reduce a parsed resume to the little we keep. Everything not named here is discarded. */
export function toWatchProfile(profile: CandidateProfile, intent: {
  countries?: string[]; locations?: string[]; remote?: boolean; excludedTerms?: string[];
} = {}): WatchProfile {
  const facts = profile.facts ?? [];
  const seniority = profile.inferences?.find((i) => i.kind === "seniority");
  const years = profile.inferences?.find((i) => i.kind === "approximate_experience_years");
  return {
    skills: clean(facts.filter((f) => f.kind === "skill").map((f) => f.value)),
    roles: clean(facts.filter((f) => f.kind === "role").map((f) => f.value), 12),
    ...(seniority ? { seniority: seniority.value as WatchProfile["seniority"] } : {}),
    roleFamilies: clean(profile.inferences?.filter((i) => i.kind === "role_family").map((i) => String(i.value)) ?? [], 6),
    ...(years && typeof years.value === "number" ? { approximateYears: years.value } : {}),
    countries: clean(intent.countries ?? [], 8).map((c) => c.toUpperCase()),
    locations: clean(intent.locations ?? [], 12),
    ...(intent.remote === true ? { remoteOnly: true } : {}),
    excludedTerms: clean(intent.excludedTerms ?? [], 16),
  };
}

/** What the candidate is told we hold, in their words rather than ours. A monitor they cannot read is a monitor
 * they cannot trust, so this is shown whenever one is created, listed or edited. */
export function describeWatchProfile(profile: WatchProfile): string {
  const parts: string[] = [];
  if (profile.roles.length) parts.push(`roles like ${profile.roles.slice(0, 3).join(", ")}`);
  if (profile.seniority) parts.push(`at ${profile.seniority} level`);
  if (profile.approximateYears !== undefined) parts.push(`around ${profile.approximateYears} years of experience`);
  if (profile.skills.length) parts.push(`skills including ${profile.skills.slice(0, 6).join(", ")}`);
  if (profile.countries.length) parts.push(`open to ${profile.countries.join(", ")}`);
  if (profile.locations.length) parts.push(`in ${profile.locations.slice(0, 4).join(", ")}`);
  if (profile.remoteOnly) parts.push("remote only");
  if (profile.excludedTerms.length) parts.push(`not ${profile.excludedTerms.slice(0, 4).join(", ")}`);
  return parts.join("; ") || "no details were derived from the resume";
}

/** The job fields a monitor needs. Deliberately the same shape the search already produces. */
export interface WatchableJob {
  id: string; title: string; company: string; location: string; remote: boolean;
  countries: string[]; skills?: string; experience?: { min: number; max?: number } | null;
}

/** Why a role matched, so a candidate is told rather than asked to trust a score. */
export interface WatchMatch { job: WatchableJob; score: number; reasons: string[] }

/**
 * Roles worth telling this candidate about. The rule is deliberately plain: a role has to look like work they
 * have done, in a place they said they would work, and not be something they asked to avoid. A clever ranking
 * that cannot be explained in one line is worse here than a simple one that can, because the candidate is reading
 * an email rather than watching a demo.
 */
export function matchWatch(profile: WatchProfile, jobs: readonly WatchableJob[], limit = 20): WatchMatch[] {
  const skills = new Set(profile.skills);
  const roleWords = new Set(profile.roles.flatMap((role) => role.split(/\s+/)).filter((w) => w.length > 3));
  const excluded = profile.excludedTerms;
  const matches: WatchMatch[] = [];
  for (const job of jobs) {
    const title = (job.title || "").toLowerCase();
    const haystack = `${title} ${(job.skills || "").toLowerCase()}`;
    if (excluded.some((term) => title.includes(term))) continue;
    if (profile.remoteOnly && !job.remote) continue;
    if (profile.countries.length && !job.countries.some((code) => profile.countries.includes(code))) continue;
    if (profile.locations.length && !job.remote) {
      const where = (job.location || "").toLowerCase();
      if (!profile.locations.some((place) => where.includes(place))) continue;
    }
    const titleHits = [...roleWords].filter((word) => title.includes(word));
    const skillHits = [...skills].filter((skill) => haystack.includes(skill));
    if (!titleHits.length && !skillHits.length) continue;
    // Stated years are the employer's requirement, so a role far above the candidate is noise rather than a stretch.
    if (profile.approximateYears !== undefined && job.experience && job.experience.min > profile.approximateYears + 3) continue;
    const reasons: string[] = [];
    if (titleHits.length) reasons.push(`the title matches your work: ${titleHits.slice(0, 3).join(", ")}`);
    if (skillHits.length) reasons.push(`asks for ${skillHits.slice(0, 4).join(", ")}`);
    if (job.experience) reasons.push(`wants ${job.experience.min}${job.experience.max ? `-${job.experience.max}` : "+"} years`);
    matches.push({ job, score: titleHits.length * 2 + skillHits.length, reasons });
  }
  return matches.sort((left, right) => right.score - left.score).slice(0, limit);
}
