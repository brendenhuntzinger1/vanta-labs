import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE ROUTE'S JOB IS TO DECIDE WHO MAY SPIN, AND TO SAY NO CLEARLY.
//
// The draw and the one-spin rule are tested in spin-service.test.ts against a
// simulated index. This file is about the gate in front of them: the promotion
// switch, the rate limit, a forged or stale link, a forwarded link opened by
// the wrong account, and where the bearer token is allowed to appear.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  enabled: true,
  campaignId: "winback_2026q4",
  rateAllowed: true,
  sessionEmail: null as string | null,
  spun: [] as Array<{ email: string; campaignId: string }>,
  spinResult: null as unknown,
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/admin-control", () => ({
  getSpinWheelConfig: async () => ({ enabled: state.enabled, campaignId: state.campaignId }),
}));

vi.mock("@/lib/admin-auth", () => ({ getRequestIpAddress: () => "203.0.113.7" }));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: state.rateAllowed, retryAfterSeconds: 42 }),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedUser: async () => (state.sessionEmail ? { id: "user-1", email: state.sessionEmail } : null),
}));

vi.mock("@/lib/spin/spin-service", () => ({
  spin: async (input: { email: string; campaignId: string }) => {
    state.spun.push(input);
    return state.spinResult;
  },
}));

const { POST } = await import("@/app/api/spin/route");
const { signSpinToken } = await import("@/lib/spin/spin-token");

const EMAIL = "lapsed@example.test";

function post(token: unknown) {
  return POST(new Request("https://vantalabsresearch.com/api/spin", {
    method: "POST",
    body: JSON.stringify({ token }),
  }));
}

function prizeResult(overrides: Record<string, unknown> = {}) {
  return {
    prize: { id: "ghk_cu", label: "Free GHK-Cu 50mg", wedgeLabel: "GHK-Cu", reward: { kind: "free_product", productSlug: "ghk-cu" }, minSubtotalCents: 7_500 },
    sliceIndex: 1,
    expiresAt: "2026-09-19T12:00:00.000Z",
    offerToken: "a-bearer-secret",
    alreadySpun: false,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.UNSUBSCRIBE_SECRET ??= "test-secret-for-spin-tokens";
  state.enabled = true;
  state.campaignId = "winback_2026q4";
  state.rateAllowed = true;
  state.sessionEmail = null;
  state.spun = [];
  state.spinResult = prizeResult();
});

describe("while the promotion is switched off", () => {
  it("does not exist, and does not admit that it exists", async () => {
    state.enabled = false;
    const response = await post(await signSpinToken(EMAIL, "winback_2026q4"));

    expect(response.status).toBe(404);
    expect(state.spun, "nothing may be minted while the wheel is off").toHaveLength(0);
  });
});

describe("the gate in front of the draw", () => {
  it("turns away a forged link without saying why", async () => {
    const response = await post("v1.bogus.bogus.99999999999.deadbeefdeadbeefdeadbeefdeadbeef");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "This link is no longer valid." });
    expect(state.spun).toHaveLength(0);
  });

  it("turns away a missing link the same way", async () => {
    expect((await post(undefined)).status).toBe(400);
    expect(state.spun).toHaveLength(0);
  });

  it("refuses a genuine link from a previous campaign", async () => {
    // Not forgeable — the campaign is signed — but it can be real and stale.
    // Honouring it would give the recipient a fresh one-live-offer slot under
    // the CURRENT campaign key and let them spin a promotion never mailed to
    // them.
    const lastQuarter = await signSpinToken(EMAIL, "winback_2026q3");
    const response = await post(lastQuarter);

    expect(response.status).toBe(400);
    expect(state.spun).toHaveLength(0);
  });

  it("rate-limits, so the endpoint cannot be hammered", async () => {
    state.rateAllowed = false;
    const response = await post(await signSpinToken(EMAIL, "winback_2026q4"));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(state.spun).toHaveLength(0);
  });
});

describe("a forwarded link", () => {
  it("is refused when a different account is signed in", async () => {
    // Minting under the token's address would bind the prize to an account this
    // person cannot check out as; minting under the session's would spend a
    // spin the recipient never got. Neither is a prize anyone can use.
    state.sessionEmail = "someone.else@example.test";
    const response = await post(await signSpinToken(EMAIL, "winback_2026q4"));

    expect(response.status).toBe(409);
    expect(state.spun).toHaveLength(0);
  });

  it("is allowed when the signed-in account is the recipient", async () => {
    state.sessionEmail = EMAIL;
    const response = await post(await signSpinToken(EMAIL, "winback_2026q4"));

    expect(response.status).toBe(200);
    expect(state.spun).toEqual([{ email: EMAIL, campaignId: "winback_2026q4" }]);
  });

  it("is allowed for an anonymous visitor, because this server signed the address", async () => {
    state.sessionEmail = null;
    const response = await post(await signSpinToken("Lapsed@Example.TEST", "winback_2026q4"));

    expect(response.status).toBe(200);
    expect(state.spun[0].email).toBe(EMAIL);
  });
});

describe("what comes back", () => {
  it("returns the wedge, the condition and the SAVED expiry", async () => {
    const response = await post(await signSpinToken(EMAIL, "winback_2026q4"));
    const body = await response.json();

    expect(body).toMatchObject({
      success: true,
      alreadySpun: false,
      sliceIndex: 1,
      // The stored instant, not a duration — a countdown seeded with "72 hours
      // from now" restarts on every refresh and promises longer each time.
      expiresAt: "2026-09-19T12:00:00.000Z",
    });
    expect(body.prize).toMatchObject({ id: "ghk_cu", minSubtotalCents: 7_500 });
    // The figure is deliberately NOT here: the wheel says a qualifying
    // purchase is needed and the cart asks for the number. See disclosure.ts.
    expect(body.prize.condition).toContain("qualifying purchase");
    expect(body.prize.condition).not.toContain("$75");
  });

  it("puts the bearer token in an httpOnly cookie and never in the body", async () => {
    const response = await post(await signSpinToken(EMAIL, "winback_2026q4"));

    expect(JSON.stringify(await response.json())).not.toContain("a-bearer-secret");
    const cookie = response.cookies.get("vl_offer");
    expect(cookie?.value).toBe("a-bearer-secret");
    expect(cookie?.httpOnly).toBe(true);
    // Strict would drop the cookie on the mail-client hop this exists for.
    expect(cookie?.sameSite).toBe("lax");
  });

  it("sets no cookie on a repeat spin, because there is no second token", async () => {
    state.spinResult = prizeResult({ offerToken: null, alreadySpun: true });
    const response = await post(await signSpinToken(EMAIL, "winback_2026q4"));

    expect((await response.json()).alreadySpun).toBe(true);
    expect(response.cookies.get("vl_offer")).toBeUndefined();
  });

  it("says so plainly when the prize could not be saved", async () => {
    // A wheel that cannot mint must not render as one that can — otherwise the
    // customer watches an animation and is handed nothing.
    state.spinResult = null;
    const response = await post(await signSpinToken(EMAIL, "winback_2026q4"));

    expect(response.status).toBe(503);
    expect((await response.json()).success).toBe(false);
  });
});
