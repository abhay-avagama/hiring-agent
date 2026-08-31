#!/usr/bin/env bun
import { createRuntime } from "./runtime.ts";
import { createToolHandler } from "./tools.ts";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface ToolHandler {
  list(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  call(name: string, input: Record<string, unknown>): Promise<unknown>;
}

export function createMcpHandler(tools: ToolHandler) {
  return async (value: unknown) => {
    if (!isRpcRequest(value)) return { jsonrpc: "2.0" as const, id: invalidRequestId(value), error: { code: -32600, message: "Invalid Request" } };
    const request = value;
    if (!("id" in request)) return null;
    const base = { jsonrpc: "2.0" as const, id: request.id ?? null };
    try {
      if (request.method === "initialize") {
        return { ...base, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "openings", version: "0.1.0" } } };
      }
      if (request.method === "ping") return { ...base, result: {} };
      if (request.method === "tools/list") return { ...base, result: { tools: tools.list() } };
      if (request.method === "tools/call") {
        if (!isRecord(request.params)) throw new Error("tools/call params must be an object");
        const name = request.params.name;
        const args = request.params.arguments;
        if (typeof name !== "string") throw new Error("tools/call requires a tool name");
        if (args !== undefined && !isRecord(args)) throw new Error("tools/call arguments must be an object");
        try {
          const result = await tools.call(name, args ?? {});
          return { ...base, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false } };
        } catch (error) {
          const details = errorDetails(error);
          const payload = { error: { message: error instanceof Error ? error.message : String(error), ...(details ?? {}) } };
          return { ...base, result: { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true } };
        }
      }
      if (request.method.startsWith("notifications/")) return null;
      return { ...base, error: { code: -32601, message: `Method not found: ${request.method}` } };
    } catch (error) {
      return { ...base, error: { code: -32602, message: error instanceof Error ? error.message : String(error) } };
    }
  };
}

function isRpcRequest(value: unknown): value is RpcRequest {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") return false;
  return !("id" in value) || value.id === null || typeof value.id === "string" || typeof value.id === "number";
}

function invalidRequestId(value: unknown): string | number | null {
  if (!isRecord(value)) return null;
  return typeof value.id === "string" || typeof value.id === "number" || value.id === null ? value.id : null;
}

function errorDetails(error: unknown): Record<string, unknown> | undefined {
  if (!isRecord(error)) return undefined;
  const allowed = new Set(["code", "field", "format", "supportedFormats"]);
  const entries = Object.entries(error).filter(([key, value]) => allowed.has(key) && value !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function serve() {
  const runtime = createRuntime();
  const catalog = {
    search: async (query: import("./types.ts").SearchQuery) => (await runtime.search(query, { offline: false, staleDays: 14 })).jobs,
    get: async (id: string) => (await runtime.get(id, { offline: false, staleDays: 14 })).job,
  };
  const handle = createMcpHandler(createToolHandler(catalog, runtime));
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response = await handle(JSON.parse(line));
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
      }
    }
  }
}

if (import.meta.main) await serve();
