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
  });

  it("reports a network failure without throwing", async () => {
    makeProduction();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    const { omnisendRequest } = await import("@/lib/marketing/omnisend/client");
    const result = await omnisendRequest({ method: "GET", path: "/contacts" });
    expect(result).toEqual({ ok: false, status: 0, body: null, error: "socket hang up" });
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
