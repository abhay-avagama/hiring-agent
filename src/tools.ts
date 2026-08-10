import type { Catalog } from "./catalog.ts";
import type { SearchQuery } from "./types.ts";

export interface ToolDefinition {
  name: "search_jobs" | "get_job";
  description: string;
  inputSchema: Record<string, unknown>;
}

export function createToolHandler(catalog: Catalog) {
  const definitions: ToolDefinition[] = [
    {
      name: "search_jobs",
      description: "Search the local job snapshot by role, location, country eligibility, and work mode.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to match in job title or company" },
          location: { type: "string", description: "Case-insensitive location substring" },
          country: { type: "string", pattern: "^[A-Za-z]{2}$", description: "Two-letter country code for job eligibility, such as IN or DE" },
          remote: { type: "boolean", description: "True for remote-only; false for non-remote-only" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_job",
      description: "Get the full description and application URL for a job returned by search_jobs.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Stable job id returned by search_jobs" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  ];

  return {
    list: () => definitions,
    async call(name: string, input: Record<string, unknown>) {
      if (name === "search_jobs") {
        const query: SearchQuery = {};
        if (typeof input.query === "string") query.query = input.query;
        if (typeof input.location === "string") query.location = input.location;
        if (typeof input.country === "string" && /^[a-z]{2}$/i.test(input.country)) query.country = input.country.toUpperCase();
        else if (input.country !== undefined) throw new Error("country must be a two-letter code");
        if (typeof input.remote === "boolean") query.remote = input.remote;
        if (typeof input.limit === "number") query.limit = Math.min(100, Math.max(1, Math.trunc(input.limit)));
        return { jobs: await catalog.search(query) };
      }
      if (name === "get_job") {
        if (typeof input.id !== "string" || !input.id) throw new Error("get_job requires a non-empty id");
        return { job: await catalog.get(input.id) };
      }
      throw new Error(`Unknown tool: ${name}`);
    },
  };
}
