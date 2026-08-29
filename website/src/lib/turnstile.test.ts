import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { turnstileIsConfigured, verifyTurnstileToken } from "@/lib/turnstile";

const ORIGINAL_SECRET = process.env.TURNSTILE_SECRET_KEY;

function siteverifyResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

describe("verifyTurnstileToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = ORIGINAL_SECRET;
  });

  it("is a no-op when no secret is configured", async () => {
    // Turnstile is optional here. Rejecting while unconfigured would turn
    // "CAPTCHA isn't set up" into "nobody can reset their password".
    delete process.env.TURNSTILE_SECRET_KEY;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(turnstileIsConfigured()).toBe(false);
    await expect(verifyTurnstileToken(null)).resolves.toEqual({ ok: true, reason: "not-configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a missing token once a secret IS configured", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    await expect(verifyTurnstileToken("   ")).resolves.toEqual({ ok: false, reason: "missing" });
  });

  it("accepts a token Cloudflare confirms", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(siteverifyResponse({ success: true }));
    await expect(verifyTurnstileToken("tok")).resolves.toEqual({ ok: true, reason: "verified" });
  });

  it("refuses a token Cloudflare rejects, and keeps the reason codes", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      siteverifyResponse({ success: false, "error-codes": ["timeout-or-duplicate"] }),
    );
    await expect(verifyTurnstileToken("spent")).resolves.toEqual({
      ok: false,
      reason: "rejected",
      codes: ["timeout-or-duplicate"],
    });
  });

  it("passes rather than blocks when Cloudflare is unreachable", async () => {
    // An outage at Cloudflare must not take account recovery down with it. The
    // endpoint's own rate limiter is the control that still holds here.
    process.env.TURNSTILE_SECRET_KEY = "secret";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));
    await expect(verifyTurnstileToken("tok")).resolves.toEqual({ ok: true, reason: "unreachable" });
  });

  it("treats a 5xx from siteverify as an outage, not a verdict", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(siteverifyResponse({}, false));
    await expect(verifyTurnstileToken("tok")).resolves.toEqual({ ok: true, reason: "unreachable" });
  });

  it("sends the secret and token to Cloudflare, and the caller IP when known", async () => {
    process.env.TURNSTILE_SECRET_KEY = "s3cr3t";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(siteverifyResponse({ success: true }));

    await verifyTurnstileToken("tok", "203.0.113.9");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = init.body as URLSearchParams;
    expect(body.get("secret")).toBe("s3cr3t");
    expect(body.get("response")).toBe("tok");
    expect(body.get("remoteip")).toBe("203.0.113.9");
  });
});
