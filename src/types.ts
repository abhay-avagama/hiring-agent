export type Ats = "greenhouse" | "lever" | "ashby";

export interface Company {
  slug: string;
  name: string;
  ats: Ats;
  token: string;
}

export interface JobSummary {
  id: string;
  company: string;
  title: string;
  location: string;
  remote: boolean;
  url: string;
  updatedAt?: string;
}

export interface Job extends JobSummary {
  description: string;
}

export interface SearchQuery {
  query?: string;
  location?: string;
  country?: "IN";
  remote?: boolean;
  limit?: number;
}
