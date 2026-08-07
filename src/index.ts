import companyData from "../data/companies.json";
import { createCatalog } from "./catalog.ts";
import type { Ats, Company } from "./types.ts";

const companies: Company[] = Object.entries(companyData).map(([slug, value]) => ({
  slug,
  name: value.name,
  ats: value.ats as Ats,
  token: value.token,
}));

export const catalog = createCatalog({ companies });
export { createCatalog } from "./catalog.ts";
export type { Catalog } from "./catalog.ts";
export type { Ats, Company, Job, JobSummary, SearchQuery } from "./types.ts";
