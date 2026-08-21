import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { connect as connectTls } from "node:tls";

export interface SafeGetResult { status: number; finalUrl: string; contentType: string; body: string; requestCount: number }
export type ResolveGetHost = (hostname: string) => Promise<string[]>;
export class SafeGetError extends Error { constructor(message: string, readonly requestCount: number, readonly failedRequestCount: number, readonly safety: boolean) { super(message); } }

export async function fetchSafeGet(value: string, options: { timeoutMs?: number; maxBytes?: number; maxRequests?: number; allowedDomain?: string; allowedOrigin?: string; resolveHost?: ResolveGetHost } = {}): Promise<SafeGetResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  let requests = 0;
  let requestInFlight = false;
  try {
    let current = checkedUrl(value);
    const allowedDomain = normalizeHost(options.allowedDomain ?? current.hostname);
    const allowedOrigin = normalizeOriginHost(options.allowedOrigin ?? current.hostname);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (redirects >= (options.maxRequests ?? 4)) throw new Error("GET request budget exhausted during redirects");
      if (!withinDomain(current.hostname, allowedDomain) || normalizeOriginHost(current.hostname) !== allowedOrigin) throw new Error("GET URL left the approved origin");
      const addresses = isIP(current.hostname) ? [current.hostname] : await resolveWithAbort((options.resolveHost ?? resolveAddresses)(current.hostname), controller.signal);
      if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) throw new Error(`URL resolves to a non-public address: ${current.hostname}`);
      requests += 1;
      requestInFlight = true;
      const response = await pinnedGet(current, addresses[0]!, controller.signal, maxBytes);
      requestInFlight = false;
      if (![301, 302, 303, 307, 308].includes(response.status)) return { ...response, finalUrl: current.href, requestCount: requests };
      const location = response.location;
      if (!location) return { ...response, finalUrl: current.href, requestCount: requests };
      const next = checkedUrl(new URL(location, current).href);
      if (!withinDomain(next.hostname, allowedDomain) || normalizeOriginHost(next.hostname) !== allowedOrigin) throw new Error("GET redirect left the approved origin");
      current = next;
    }
    throw new Error("GET redirect limit exceeded");
  } catch (error) { const message = error instanceof Error ? error.message : String(error); throw new SafeGetError(message, requests, requestInFlight ? 1 : 0, /non-public|approved origin|company domain|credential-free HTTPS|request budget|redirect limit|content encoding|exceeds \d+ bytes/i.test(message)); }
  finally { clearTimeout(timer); }
}

function checkedUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password) throw new Error("Probe URL must use credential-free HTTPS on port 443");
  return url;
}

function pinnedGet(url: URL, address: string, signal: AbortSignal, maxBytes: number): Promise<{ status: number; contentType: string; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET", signal, servername: url.hostname, agent: false,
      headers: { accept: "text/html,application/xml,text/xml,text/plain", "accept-encoding": "identity", "user-agent": "Openings/0.1 (+https://github.com/)" },
      createConnection: () => connectTls({ host: address, port: 443, servername: url.hostname }),
    }, (response) => {
      const encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase();
      if (encoding !== "identity") { response.destroy(); reject(new Error(`Unsupported content encoding: ${encoding}`)); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { response.destroy(new Error(`Response exceeds ${maxBytes} bytes`)); return; }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode ?? 500, contentType: String(response.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8"), location: typeof response.headers.location === "string" ? response.headers.location : undefined }));
    });
    req.once("error", reject);
    req.end();
  });
}

async function resolveAddresses(hostname: string): Promise<string[]> { return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address); }
function normalizeHost(value: string) { return value.toLowerCase().replace(/^www\./, ""); }
function normalizeOriginHost(value: string) { return value.toLowerCase(); }
function withinDomain(host: string, domain: string): boolean { const value = normalizeHost(host); return value === domain || value.endsWith(`.${domain}`); }
function resolveWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) { const [a, b] = address.split(".").map(Number); return !(a === 0 || a === 10 || a === 127 || a === 100 && b! >= 64 && b! <= 127 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && (b === 0 || b === 168) || a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0 || a! >= 224); }
  if (isIP(address) === 6) { const value = address.toLowerCase(); return !(value === "::" || value === "::1" || value.startsWith("::ffff:") || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value) || value.startsWith("ff") || value.startsWith("2001:db8")); }
  return false;
}
