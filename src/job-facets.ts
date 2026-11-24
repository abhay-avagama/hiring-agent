import type { Experience } from "./experience.ts";

/**
 * Role family, seniority and Indian city/state, read from a job's title, location and stated experience.
 * Derived when a result is built rather than stored: every input is already on the stored job, so nothing goes stale
 * and there is no version to bump. Rules, not a model. Anything the title does not say plainly is "other" or absent.
 */

export const JOB_ROLES = [
  "backend", "frontend", "fullstack", "mobile", "software", "data-engineering", "ml-ai", "devops-infrastructure",
  "qa-testing", "security", "hardware-embedded", "enterprise-apps", "data-science", "analytics", "product", "design",
  "sales", "marketing", "customer-support", "finance", "hr-recruiting", "operations", "legal", "consulting", "core-engineering", "other",
] as const;
export type JobRole = (typeof JOB_ROLES)[number];

export const SENIORITIES = ["intern", "entry", "mid", "senior", "lead", "manager", "director"] as const;
export type Seniority = (typeof SENIORITIES)[number];

export interface JobFacets { role: JobRole; seniority?: Seniority; cities?: string[]; states?: string[] }

// Within a list the first match wins, so the specific families come before the broad ones ("Data Engineer" before "Engineer").
const ALWAYS: Array<[JobRole, RegExp]> = [
  ["legal", /\b(legal|lawyer|attorney|counsel|paralegal|advocate|compliance officer|company secretary)\b/],
  ["hr-recruiting", /\b(recruit\w*|talent acquisition|human resources?|hr|hrbp|people partner|payroll|sourcer|people operations)\b/],
];
const TECH: Array<[JobRole, RegExp]> = [
  ["security", /\b(security|cyber\s?security|infosec|soc analyst|penetration|pentest\w*|appsec|iam|vulnerability|threat)\b/],
  ["ml-ai", /\b(machine learning|ml|ai|artificial intelligence|deep learning|nlp|computer vision|llm|gen ?ai|generative ai|mlops)\b/],
  ["data-science", /\b(data scien\w*|scientist|statistician|quantitative|quant)\b/],
  ["data-engineering", /\b(data engineer\w*|etl|data warehous\w*|big data|data platform|databricks|snowflake|spark|hadoop|data architect|database|dba|data modeler)\b/],
  ["analytics", /\b(data analyst|business analyst|analytics|business intelligence|bi|power bi|tableau|mis|reporting analyst|insights analyst)\b/],
  ["qa-testing", /\b(qa|quality assurance|test\w*|sdet|automation engineer|quality engineer)\b/],
  ["devops-infrastructure", /\b(devops|sre|site reliability|cloud|infrastructure|platform|kubernetes|network|system administrator|sysadmin|systems engineer|linux|release engineer|build engineer|middleware)\b/],
  ["hardware-embedded", /\b(embedded|firmware|vlsi|asic|fpga|rtl|verification engineer|physical design|analog|hardware|pcb|electronics|silicon|soc design|dft|layout engineer)\b/],
  ["enterprise-apps", /\b(sap|salesforce|servicenow|oracle|workday|dynamics 365|d365|guidewire|pega|mainframe|cobol|peoplesoft|siebel|netsuite|sfdc|abap)\b/],
  ["mobile", /\b(android|ios|mobile|flutter|react native|swift|kotlin)\b/],
  ["fullstack", /\b(full[- ]?stack|mern|mean stack)\b/],
  ["frontend", /\b(front[- ]?end|ui developer|ui engineer|react(?:\.?js)?|angular|vue|javascript|web developer)\b/],
  ["backend", /\b(back[- ]?end|java|python|golang|go developer|node(?:\.?js)?|dotnet|php|ruby|api|microservices|c\+\+|scala|rust|django|spring)\b/],
  // Plant, field and site engineering: large in Indian manufacturing, and not software work.
  ["core-engineering", /\b(mechanical|electrical|civil|chemical|production|manufacturing|process engineer|maintenance|field service|service engineer|site engineer|project engineer|design engineer|instrumentation|telecom|automobile|automotive|piping|structural|hvac|plant|tooling|cnc|welding|metallurg\w*|mining|quality control|graduate engineer trainee|diploma engineer)\b/],
  ["software", /\b(software|developer|programmer|sde|swe|engineer(?:ing)? manager|application engineer|product engineer|engineering (?:manager|director|head|lead)|(?:manager|director|head|vp|vice president) (?:of )?engineering|cto|chief technology officer|solutions? architect|technical architect|architect|coder|tech lead)\b/],
];
const BUSINESS: Array<[JobRole, RegExp]> = [
  ["design", /\b(designer|design lead|ux|ui ux|user experience|user research\w*|illustrator|animator|visual design|creative director)\b/],
  ["product", /\b(product manager|product owner|product management|head of product|product lead|product analyst|vp product|chief product)\b/],
  ["customer-support", /\b(customer (?:support|service|success|care|experience)|support (?:engineer|specialist|executive|associate|analyst)|technical support|help ?desk|service desk|call cent\w*|voice process|client servic\w*|desktop support)\b/],
  ["sales", /\b(sales|account executive|business development|bde|bdm|account manager|key account|inside sales|presales|pre-sales|relationship manager|territory|channel partner|partnerships?|revenue|lead generation)\b/],
  ["marketing", /\b(marketing|seo|sem|content|brand|growth|social media|communications|public relations|copywriter|demand generation|campaign)\b/],
  ["finance", /\b(financ\w*|accountant|accounting|accounts|audit\w*|tax|treasury|controller|fp&a|chartered accountant|credit analyst|underwrit\w*|actuar\w*|billing|invoic\w*|bookkeep\w*|cfo)\b/],
  // "SAP FICO Consultant" is SAP work and "Cyber Security Consultant" is security work, whatever the noun.
  ["security", /\b(security|cyber\s?security|infosec|soc analyst|penetration|pentest\w*|appsec|iam|vulnerability|threat)\b/],
  ["enterprise-apps", /\b(sap|salesforce|servicenow|oracle|workday|dynamics 365|d365|guidewire|pega|mainframe|cobol|peoplesoft|siebel|netsuite|sfdc|abap)\b/],
  ["consulting", /\b(consultant|consulting|advisory)\b/],
  ["operations", /\b(operations|supply chain|logistics|procurement|purchase|warehouse|inventory|admin\w*|office manager|facilities|project manager|program(?:me)? manager|project coordinator|delivery manager|scrum master|planner|dispatch)\b/],
];
// A title naming a technical worker reads its technical families first: "Sales Engineer" is still sales (no technical
// family matches), but "Software Engineer, Finance Systems" is software, and "AI Sales Executive" is sales.
const TECH_WORKER = /\b(engineer\w*|developer|programmer|scientist|architect|sde|swe|sdet|devops|sre|administrator|dba|coder|tech lead)\b/;

/** Lowercase, with symbols that hide words ("Sr./Lead", "Front-End|React") turned into spaces. */
function clean(title: string): string {
  return title.toLowerCase().replace(/&amp;/g, "&").replace(/(^|\s)\.net\b/g, "$1dotnet").replace(/[|/,()[\]_:;–—]+/g, " ").replace(/\s+/g, " ").trim();
}

export function roleFamily(title: string): JobRole {
  const text = clean(title);
  // ponytail: a fixed regex list, first match wins. Misreads show up as "other" or a sibling family; a trained
  // classifier is the upgrade if the hand-labelled eval says the rules plateau.
  const order = TECH_WORKER.test(text) ? [...ALWAYS, ...TECH, ...BUSINESS] : [...ALWAYS, ...BUSINESS, ...TECH];
  return order.find(([, pattern]) => pattern.test(text))?.[0] ?? "other";
}

// "Product Manager" or "Relationship Manager" names a job, not a rung on a ladder.
const ROLE_NOUN_MANAGER = /\b(product|project|program|programme|account|relationship|territory|area|case|community|content|social media|brand|category|delivery|key account|sales|marketing|campaign|portfolio|customer success|customer service|property|branch|store|cluster|regional sales|business development|payroll|release|credit|collection)s? manager\b/;
const LEVEL_NUMBER = /\b(?:sde|swe|sdet|qa|tester|engineer|developer|analyst|associate|consultant|scientist)[\s-]*(iv|iii|ii|i|[1-5])\b/;

export function seniority(title: string, experience?: Experience | null): Seniority | undefined {
  const text = clean(title);
  if (/\b(intern|internship|apprentice\w*)\b/.test(text)) return "intern";
  if (/\b(director|head of|head -|chief|cto|ceo|cfo|coo|cio|ciso|cxo|president|svp|evp|(?<!(?:business|channel|delivery|people|success|finance|learning|hr) )partner)\b/.test(text) && !/\bassistant vice president|\bavp\b/.test(text)) {
    // A bank's "Vice President" is a corporate title on an engineer, not a director.
    if (!/\bvice president\b/.test(text) || !/\b(engineer\w*|developer|analyst|associate|scientist)\b/.test(text)) return "director";
  }
  if (/\bhead\b/.test(text) && !/\b(head ?count|headless)\b/.test(text)) return "director";
  if (/\bmanager\b/.test(text) && !ROLE_NOUN_MANAGER.test(text)) return "manager";
  // "Staff Nurse" is a ward nurse; "Staff" is a level only in front of technical or product work.
  if (/\b(lead|leader|principal|architect|distinguished|fellow|staff (?:engineer|software|data|ml|machine|product|research|security|backend|frontend|full|platform|site|devops|designer|scientist|developer|analyst))\b/.test(text) && !/\blead generation\b/.test(text)) return "lead";
  if (/\b(senior|sr\.?|snr|avp|assistant vice president|vice president)\b/.test(text)) return "senior";
  const level = LEVEL_NUMBER.exec(text)?.[1];
  if (level) return { i: "entry", "1": "entry", ii: "mid", "2": "mid", iii: "senior", "3": "senior", iv: "lead", "4": "lead", "5": "lead" }[level] as Seniority;
  if (/\b(junior|jr\.?|graduate|fresher\w*|trainee|entry level|entry-level|campus)\b/.test(text)) return "entry";
  // ponytail: "Associate" alone is entry in IT services (Accenture, Infosys); "Senior Associate" was caught above.
  if (/\bassociate\b/.test(text) && !/\bassociate (director|manager|vice president|partner|principal|architect)\b/.test(text)) return "entry";
  if (/\b(mid[- ]level|intermediate)\b/.test(text)) return "mid";
  if (!experience) return undefined;
  // The posting's stated minimum when the title says nothing about level.
  return experience.min < 2 ? "entry" : experience.min < 5 ? "mid" : experience.min < 9 ? "senior" : "lead";
}

// Canonical city -> [state, spellings]. Cities that hold most India roles, plus the state capitals.
const INDIA_CITIES: Record<string, [string, string[]]> = {
  Bengaluru: ["Karnataka", ["bengaluru", "bangalore", "blr", "banglore", "bengalore", "bangaluru"]],
  Hyderabad: ["Telangana", ["hyderabad", "secunderabad", "hitec city", "hitech city", "gachibowli"]],
  Pune: ["Maharashtra", ["pune", "hinjewadi", "hinjawadi", "kharadi", "magarpatta"]],
  Mumbai: ["Maharashtra", ["mumbai", "bombay", "navi mumbai", "thane", "powai", "andheri", "bkc"]],
  Chennai: ["Tamil Nadu", ["chennai", "madras"]],
  Gurugram: ["Haryana", ["gurugram", "gurgaon", "ggn"]],
  Noida: ["Uttar Pradesh", ["noida", "greater noida", "gautam buddha nagar"]],
  Delhi: ["Delhi", ["delhi", "new delhi", "delhi ncr", "ncr"]],
  Kolkata: ["West Bengal", ["kolkata", "calcutta", "salt lake"]],
  Ahmedabad: ["Gujarat", ["ahmedabad", "gandhinagar", "gift city"]],
  Kochi: ["Kerala", ["kochi", "cochin", "ernakulam", "kakkanad", "infopark"]],
  Thiruvananthapuram: ["Kerala", ["thiruvananthapuram", "trivandrum", "technopark"]],
  Coimbatore: ["Tamil Nadu", ["coimbatore"]],
  Jaipur: ["Rajasthan", ["jaipur"]],
  Indore: ["Madhya Pradesh", ["indore"]],
  Bhopal: ["Madhya Pradesh", ["bhopal"]],
  Chandigarh: ["Chandigarh", ["chandigarh", "mohali", "panchkula"]],
  Lucknow: ["Uttar Pradesh", ["lucknow"]],
  Nagpur: ["Maharashtra", ["nagpur"]],
  Nashik: ["Maharashtra", ["nashik", "nasik"]],
  Aurangabad: ["Maharashtra", ["aurangabad", "chhatrapati sambhajinagar"]],
  Vadodara: ["Gujarat", ["vadodara", "baroda"]],
  Surat: ["Gujarat", ["surat"]],
  Mysuru: ["Karnataka", ["mysuru", "mysore"]],
  Mangaluru: ["Karnataka", ["mangaluru", "mangalore"]],
  Hubballi: ["Karnataka", ["hubballi", "hubli", "dharwad"]],
  Bhubaneswar: ["Odisha", ["bhubaneswar", "bhubaneshwar"]],
  Visakhapatnam: ["Andhra Pradesh", ["visakhapatnam", "vizag"]],
  Vijayawada: ["Andhra Pradesh", ["vijayawada"]],
  Madurai: ["Tamil Nadu", ["madurai"]],
  Tiruchirappalli: ["Tamil Nadu", ["tiruchirappalli", "trichy"]],
  Patna: ["Bihar", ["patna"]],
  Ranchi: ["Jharkhand", ["ranchi"]],
  Raipur: ["Chhattisgarh", ["raipur"]],
  Dehradun: ["Uttarakhand", ["dehradun"]],
  Guwahati: ["Assam", ["guwahati"]],
  Goa: ["Goa", ["goa", "panaji", "panjim", "margao", "vasco da gama"]],
  Faridabad: ["Haryana", ["faridabad"]],
  Ghaziabad: ["Uttar Pradesh", ["ghaziabad"]],
  Ludhiana: ["Punjab", ["ludhiana"]],
  Amritsar: ["Punjab", ["amritsar"]],
  Kanpur: ["Uttar Pradesh", ["kanpur"]],
  Varanasi: ["Uttar Pradesh", ["varanasi"]],
  Rajkot: ["Gujarat", ["rajkot"]],
  Jamshedpur: ["Jharkhand", ["jamshedpur"]],
  Srinagar: ["Jammu and Kashmir", ["srinagar"]],
  Puducherry: ["Puducherry", ["puducherry", "pondicherry"]],
  Kozhikode: ["Kerala", ["kozhikode", "calicut"]],
  Salem: ["Tamil Nadu", ["salem"]],
  Hosur: ["Tamil Nadu", ["hosur"]],
};
const INDIA_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana", "Himachal Pradesh",
  "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha",
  "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
  "Chandigarh", "Delhi", "Jammu and Kashmir", "Puducherry",
];
const SPELLINGS = Object.entries(INDIA_CITIES).flatMap(([city, [, names]]) => names.map((name) => [name, city] as const))
  .sort((left, right) => right[0].length - left[0].length);
const CITY_PATTERN = new RegExp(`\\b(${SPELLINGS.map(([name]) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "g");
const STATE_PATTERN = new RegExp(`\\b(${INDIA_STATES.join("|")}|orissa|tamilnadu|jammu & kashmir)\\b`, "gi");

/** Indian cities a location names, canonical and in the order written; the states follow from them and from state names. */
export function indiaPlaces(location: string): { cities: string[]; states: string[] } {
  const text = location.toLowerCase().replace(/&amp;/g, "&");
  const byName = new Map<string, string>(SPELLINGS);
  const cities = [...new Set([...text.matchAll(CITY_PATTERN)].map((match) => byName.get(match[1]!)!))];
  const named = [...location.matchAll(STATE_PATTERN)].map((match) => {
    const value = match[1]!.toLowerCase();
    return value === "orissa" ? "Odisha" : value === "tamilnadu" ? "Tamil Nadu" : value === "jammu & kashmir" ? "Jammu and Kashmir" : INDIA_STATES.find((state) => state.toLowerCase() === value)!;
  });
  // "Goa" and "Delhi" are both a city and a state: the city entry already carries the state.
  const states = [...new Set([...cities.map((city) => INDIA_CITIES[city]![0]), ...named])];
  return { cities, states };
}

export function jobFacets(job: { title: string; location: string; eligibleCountries: string[]; experience?: Experience | null }): JobFacets {
  const facets: JobFacets = { role: roleFamily(job.title) };
  const level = seniority(job.title, job.experience);
  if (level) facets.seniority = level;
  // Kochi and Salem are also in Japan and the United States; only read Indian places off a role open in India.
  if (job.eligibleCountries.includes("IN")) {
    const { cities, states } = indiaPlaces(job.location);
    if (cities.length) facets.cities = cities;
    if (states.length) facets.states = states;
  }
  return facets;
}
