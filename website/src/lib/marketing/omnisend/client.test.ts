import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Omnisend transport, driven for real with a stubbed fetch.
 *
 * Same bar as ads-environment-enforcement.test.ts: every refusal reason must
 * produce ZERO network calls, and production must reach fetch with the exact
 * headers Omnisend requires. The key is read only after the gate, so a
 * preview deployment that inherited production's variables still sends
 * nothing.
 */

const ORIGINAL = {
  vercelEnv: process.env.VERCEL_ENV,
  nodeEnv: process.env.NODE_ENV,
  ci: process.env.CI,
  key: process.env.OMNISEND_API_KEY,
};

function makeProduction(withKey = true) {
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CI", "");
  if (withKey) vi.stubEnv("OMNISEND_API_KEY", "tok-omnisend");
  else vi.stubEnv("OMNISEND_API_KEY", "");
}

let calls: unknown[][] = [];
function stubFetch(status = 200, body: unknown = { ok: true }) {
  const spy = vi.fn(async (...args: unknown[]) => {
    calls.push(args);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** One response per call, in order; the last one repeats. */
function stubFetchSequence(statuses: number[], body: unknown = { ok: true }, retryAfter?: string) {
  let index = 0;
  const spy = vi.fn(async (...args: unknown[]) => {
    calls.push(args);
    const status = statuses[Math.min(index, statuses.length - 1)];
    index += 1;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? retryAfter ?? null : null) },
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(() => {
  calls = [];
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  // NODE_ENV is typed read-only; restore through the untyped view, as the
  // ads enforcement suite does.
  const env = process.env as Record<string, string | undefined>;
  env.VERCEL_ENV = ORIGINAL.vercelEnv;
  env.NODE_ENV = ORIGINAL.nodeEnv;
  env.CI = ORIGINAL.ci;
  env.OMNISEND_API_KEY = ORIGINAL.key;
});

describe("omnisendRequest refuses to leave a non-production deployment", () => {
  it.each([
    ["a preview deployment", () => { makeProduction(); vi.stubEnv("VERCEL_ENV", "preview"); }, "not_production_environment"],
    ["a non-production build", () => { makeProduction(); vi.stubEnv("NODE_ENV", "test"); }, "not_production_build"],
    ["a CI runner", () => { makeProduction(); vi.stubEnv("CI", "true"); }, "automated_environment"],
  ])("sends nothing from %s", async (_label, arrange, reason) => {
    arrange();
    stubFetch();
    const { omnisendRequest } = await import("@/lib/marketing/omnisend/client");
    const result = await omnisendRequest({ method: "POST", path: "/contacts", body: { a: 1 } });
    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`ads reporting disabled: ${reason}`);
  });

  it("sends nothing without an API key, even on production", async () => {
    makeProduction(false);
    stubFetch();
    const { omnisendRequest } = await import("@/lib/marketing/omnisend/client");
    const result = await omnisendRequest({ method: "GET", path: "/contacts" });
    expect(calls).toHaveLength(0);
    expect(result.error).toBe("OMNISEND_API_KEY not set");
  });
});

describe("omnisendRequest on a real production deployment", () => {
  it("reaches Omnisend with the key, the version header and a JSON body", async () => {
    makeProduction();
    stubFetch(202, { received: true });
    const { omnisendRequest } = await import("@/lib/marketing/omnisend/client");
    const result = await omnisendRequest<{ received: boolean }>({ method: "POST", path: "/events", body: { eventName: "x" } });
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.omnisend.com/api/events");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Omnisend-API-Key tok-omnisend");
    expect(headers["Omnisend-Version"]).toBe("2026-03-15");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ eventName: "x" }));
    expect(result).toEqual({ ok: true, status: 202, body: { received: true }, error: null });
  });

  it("reports a rejected call without throwing", async () => {
    makeProduction();
    stubFetch(400, { errors: [{ message: "bad" }] });
    const { omnisendRequest } = await import("@/lib/marketing/omnisend/client");
    const result = await omnisendRequest({ method: "POST", path: "/contacts", body: {} });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("omnisend 400");
    // A 400 is the request's fault; sending it again is not a retry, it is a repeat.
    expect(calls).toHaveLength(1);
  });

  it("reports a network failure without throwing", async () => {
    makeProduction();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    const { omnisendRequest } = await import("@/lib/marketing/omnisend/client");
    const result = await omnisendRequest({ method: "GET", path: "/contacts", retryDelayMs: 0 });
    expect(result).toEqual({ ok: false, status: 0, body: null, error: "socket hang up" });
  });

  /**
   * Omnisend's API guide: 429, 500, 503 and 524 and socket failures MUST be
   * retried with backoff; 4xx must not. One bounded retry is what a request
   * path can afford (the ledger and the backstop sweep carry the rest).
   */
  describe("retries exactly the failures Omnisend says to retry", () => {
    it.each([429, 500, 503, 524])("retries a %i once and returns the second answer", async (status) => {
      makeProduction();
      stubFetchSequence([status, 200], { fine: true });
      const { omnisendRequest } = await import("@/lib/marketing/omnisend/client");
      const result = await omnisendRequest({ method: "POST", path: "/events", body: {}, retryDelayMs: 0 });
      expect(calls).toHaveLength(2);
      expect(result).toEqual({ ok: true, status: 200, body: { fine: true }, error: null });
    });

    it("gives up after the one retry and reports the last status", async () => {
      makeProduction();
      stubFetchSequence([503, 503]);
      const { omnisendRequest } = await import("@/lib/marketing/omnisend/client");
      const result = await omnisendRequest({ method: "POST", path: "/events", body: {}, retryDelayMs: 0 });
      expect(calls).toHaveLength(2);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(503);
    });

    it("retries a socket failure once, then reports it", async () => {
      makeProduction();
      let attempt = 0;
      vi.stubGlobal("fetch", vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        attempt += 1;
        if (attempt === 1) throw new Error("socket hang up");
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" } as unknown as Response;
      }));
      const { omnisendRequest } = await import("@/lib/marketing/omnisend/client");
      const result = await omnisendRequest({ method: "GET", path: "/contacts", retryDelayMs: 0 });
      expect(calls).toHaveLength(2);
      expect(result.ok).toBe(true);
    });

    it.each([400, 401, 402, 404, 422])("never retries a %i", async (status) => {
      makeProduction();
      stubFetchSequence([status, 200]);
      const { omnisendRequest } = await import("@/lib/marketing/omnisend/client");
      const result = await omnisendRequest({ method: "POST", path: "/events", body: {}, retryDelayMs: 0 });
      expect(calls).toHaveLength(1);
      expect(result.status).toBe(status);
    });

    it("honours retries: 0", async () => {
      makeProduction();
      stubFetchSequence([429, 200]);
      const { omnisendRequest } = await import("@/lib/marketing/omnisend/client");
      const result = await omnisendRequest({ method: "POST", path: "/events", body: {}, retries: 0, retryDelayMs: 0 });
      expect(calls).toHaveLength(1);
      expect(result.status).toBe(429);
    });

    it("waits for Retry-After, capped, before the retry", async () => {
      makeProduction();
      // A ten-millisecond Retry-After keeps the test fast; the cap and the
      // fallbacks are asserted on the pure function.
      stubFetchSequence([429, 200], { ok: true }, "0.01");
      const { omnisendRequest, retryDelayFor } = await import("@/lib/marketing/omnisend/client");
      expect(retryDelayFor("120", 1_000)).toBe(5_000);
      expect(retryDelayFor("2", 1_000)).toBe(2_000);
      expect(retryDelayFor(null, 1_000)).toBe(1_000);
      expect(retryDelayFor("soon", 1_000)).toBe(1_000);
      expect(retryDelayFor("-3", 1_000)).toBe(1_000);
      const started = Date.now();
      const result = await omnisendRequest({ method: "POST", path: "/events", body: {}, retryDelayMs: 0 });
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });

  it("omnisendActive is true only when the gate passes AND the key is set", async () => {
    makeProduction();
    const { omnisendActive } = await import("@/lib/marketing/omnisend/client");
    expect(omnisendActive()).toEqual({ active: true, reason: null });
    vi.stubEnv("OMNISEND_API_KEY", "");
    vi.resetModules();
    const again = await import("@/lib/marketing/omnisend/client");
    expect(again.omnisendActive()).toEqual({ active: false, reason: "OMNISEND_API_KEY not set" });
    vi.stubEnv("OMNISEND_API_KEY", "tok");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.resetModules();
    const preview = await import("@/lib/marketing/omnisend/client");
    expect(preview.omnisendActive()).toEqual({ active: false, reason: "not_production_environment" });
  });
});

describe("config is pure and reads only what it is given", () => {
  it("omnisendOwnsMarketing accepts true/1/yes and nothing else", async () => {
    const { omnisendOwnsMarketing } = await import("@/lib/marketing/omnisend/config");
    for (const value of ["true", "TRUE", "1", "yes"]) {
      expect(omnisendOwnsMarketing({ OMNISEND_MARKETING_OWNER: value } as unknown as NodeJS.ProcessEnv)).toBe(true);
    }
    for (const value of ["", "false", "0", "no", undefined]) {
      expect(omnisendOwnsMarketing({ OMNISEND_MARKETING_OWNER: value } as unknown as NodeJS.ProcessEnv)).toBe(false);
    }
  });
});
