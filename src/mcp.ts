#!/usr/bin/env bun
import { createRuntime } from "./runtime.ts";
import { createToolHandler } from "./tools.ts";
import { usageEventFor } from "./usage.ts";
import { VERSION } from "./version.ts";
import { startUpdateCheck, type UpdateNotice } from "./update-check.ts";

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

export function createMcpHandler(tools: ToolHandler, options: { update?: () => UpdateNotice | null } = {}) {
  /** A pending update rides on every tool result so the AI app can prompt the person; nothing is changed on their machine. */
  const withUpdate = (payload: unknown) => { const update = options.update?.(); return update && isRecord(payload) ? { ...payload, updateAvailable: update } : payload; };
  return async (value: unknown) => {
    if (!isRpcRequest(value)) return { jsonrpc: "2.0" as const, id: invalidRequestId(value), error: { code: -32600, message: "Invalid Request" } };
    const request = value;
    if (!("id" in request)) return null;
    const base = { jsonrpc: "2.0" as const, id: request.id ?? null };
    try {
      if (request.method === "initialize") {
        const update = options.update?.();
        return { ...base, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "openings", version: VERSION }, ...(update ? { instructions: update.message } : {}) } };
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
          return { ...base, result: { content: [{ type: "text", text: JSON.stringify(withUpdate(result), null, 2) }], isError: false } };
        } catch (error) {
          const details = errorDetails(error);
          const payload = { error: { message: error instanceof Error ? error.message : String(error), ...(details ?? {}) } };
          return { ...base, result: { content: [{ type: "text", text: JSON.stringify(withUpdate(payload), null, 2) }], isError: true } };
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
  const updates = startUpdateCheck({ enabled: (process.env.OPENINGS_UPDATE_CHECK ?? "on").toLowerCase() !== "off" });
  const handle = createMcpHandler(createToolHandler(catalog, runtime, { onCall: (name, input, result) => runtime.usage?.record(usageEventFor(name, input, result)) }), { update: updates.get });
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
  await runtime.usage?.flush();
}

if (import.meta.main) await serve();
