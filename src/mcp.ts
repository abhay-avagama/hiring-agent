#!/usr/bin/env bun
import { catalog } from "./index.ts";
import { createToolHandler } from "./tools.ts";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolHandler {
  list(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  call(name: string, input: Record<string, unknown>): Promise<unknown>;
}

export function createMcpHandler(tools: ToolHandler) {
  return async (request: RpcRequest) => {
    const base = { jsonrpc: "2.0" as const, id: request.id ?? null };
    try {
      if (request.method === "initialize") {
        return { ...base, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "openings", version: "0.1.0" } } };
      }
      if (request.method === "ping") return { ...base, result: {} };
      if (request.method === "tools/list") return { ...base, result: { tools: tools.list() } };
      if (request.method === "tools/call") {
        const name = request.params?.name;
        const args = request.params?.arguments;
        if (typeof name !== "string") throw new Error("tools/call requires a tool name");
        const result = await tools.call(name, isRecord(args) ? args : {});
        return { ...base, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false } };
      }
      if (request.method.startsWith("notifications/")) return null;
      return { ...base, error: { code: -32601, message: `Method not found: ${request.method}` } };
    } catch (error) {
      return { ...base, error: { code: -32602, message: error instanceof Error ? error.message : String(error) } };
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function serve() {
  const handle = createMcpHandler(createToolHandler(catalog));
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response = await handle(JSON.parse(line) as RpcRequest);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
      }
    }
  }
}

if (import.meta.main) await serve();
