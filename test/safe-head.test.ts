import { describe, expect, test } from "bun:test";
import { fetchSafeHead } from "../src/safe-head.ts";

describe("fetchSafeHead", () => {
  test("bounds DNS resolution with the request timeout", async () => {
    await expect(fetchSafeHead("https://example.com/careers", {
      timeoutMs: 5,
      resolveHost: () => new Promise(() => {}),
    })).rejects.toThrow("Timed out after 5ms");
  });

  test("bounds a transport that does not honor AbortSignal", async () => {
    await expect(fetchSafeHead("https://example.com/careers", {
      timeoutMs: 5,
      resolveHost: async () => ["93.184.216.34"],
      transport: () => new Promise(() => {}),
    })).rejects.toThrow("Timed out after 5ms");
  });
});
