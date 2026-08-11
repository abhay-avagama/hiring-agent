import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { connect as connectTls } from "node:tls";

export type ResolveHost = (hostname: string) => Promise<string[]>;
export type HeadTransport = (url: URL, address: string, signal: AbortSignal) => Promise<Response>;
export interface SafeHeadResult { response: Response; finalUrl: string }

export async function fetchSafeHead(url: string, options: { resolveHost?: ResolveHost; transport?: HeadTransport; timeoutMs?: number } = {}): Promise<SafeHeadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${options.timeoutMs ?? 15_000}ms`)), options.timeoutMs ?? 15_000);
  try {
    let current = new URL(url);
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const address = await withAbort(publicAddress(current, options.resolveHost ?? resolveAddresses), controller.signal);
      const response = await withAbort((options.transport ?? pinnedHead)(current, address, controller.signal), controller.signal);
      if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: current.href };
      const location = response.headers.get("location");
      if (!location) return { response, finalUrl: current.href };
      current = new URL(location, current);
      if (current.protocol !== "https:") throw new Error("Career redirect must use HTTPS");
    }
    throw new Error("Career redirect limit exceeded");
  } finally { clearTimeout(timer); }
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
}

async function publicAddress(url: URL, resolveHost: ResolveHost): Promise<string> {
  if (url.protocol !== "https:") throw new Error("Career URL must use HTTPS");
  const addresses = isIP(url.hostname) ? [url.hostname] : await resolveHost(url.hostname);
  const publicAddresses = addresses.filter(isPublicAddress);
  if (!addresses.length || publicAddresses.length !== addresses.length) throw new Error(`Career URL resolves to a non-public address: ${url.hostname}`);
  return publicAddresses[0]!;
}

function pinnedHead(url: URL, address: string, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "HEAD", signal, servername: url.hostname, agent: false,
      createConnection: () => {
        const socket = connectTls({ host: address, port: Number(url.port || 443), servername: url.hostname });
        const destroy = () => socket.destroy(signal.reason instanceof Error ? signal.reason : undefined);
        if (signal.aborted) destroy();
        else signal.addEventListener("abort", destroy, { once: true });
        return socket;
      },
    }, (response) => resolve(new Response(null, { status: response.statusCode ?? 500, headers: response.headers as HeadersInit })));
    req.once("error", reject);
    req.end();
  });
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || a! >= 224);
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    return !(value === "::" || value === "::1" || value.startsWith("::ffff:") || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value) || value.startsWith("ff") || value.startsWith("2001:db8"));
  }
  return false;
}
