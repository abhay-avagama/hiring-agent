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
      description: "Search live public company job boards by role, location, and remote status.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to match in job title or company" },
          location: { type: "string", description: "Case-insensitive location substring" },
          country: { type: "string", enum: ["IN"], description: "Use IN for roles explicitly located in India or remote across India/APAC/Asia/global" },
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
        if (input.country === "IN") query.country = "IN";
        else if (input.country !== undefined) throw new Error("country currently supports only IN");
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
