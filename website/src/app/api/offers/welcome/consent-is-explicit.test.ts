import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A NUMBER ARRIVING IS NOT SOMEBODY AGREEING.
//
// The endpoint used to infer consent from a phone being present, which was
// safe only while the sole reason to send one was a ticked box. The wheel
// broke that: it collects a number from everybody.
//
// The direction of the default is the whole point. A caller that forgets the
// field UNDER-claims — the store keeps a number and has to ask again — and the
// alternative failure mode is a text to somebody who never agreed.
// ---------------------------------------------------------------------------

const calls = vi.hoisted(() => ({
  consented: [] as unknown[],
  stored: [] as unknown[],
  signupOnly: [] as unknown[],
}));
const state = vi.hoisted(() => ({ promptsEnabled: true, sessionEmail: "shopper@example.test" as string | null }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-control", () => ({
  getSmsSignupConfig: async () => ({ promptsEnabled: state.promptsEnabled, dismissCooldownDays: 7, holdoutPercent: 0 }),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedUser: async () => (state.sessionEmail ? { id: "user-1", email: state.sessionEmail } : null),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/request-ip", () => ({ rateLimitKeyForRequest: () => "k" }));
vi.mock("@/lib/offers/welcome-offer", () => ({
  readWelcomeOffer: async () => ({ status: "eligible", mayInterrupt: true }),
  claimWelcomeOffer: async (input: unknown) => { calls.consented.push(input); return { ok: true, subscribedOnly: true }; },
  recordSmsSignupOnly: async (input: unknown) => { calls.signupOnly.push(input); return true; },
  recordPhoneWithoutConsent: async (input: unknown) => { calls.stored.push(input); return true; },
}));

const { POST } = await import("./route");

const post = (body: unknown) => POST(new Request("https://vantalabs.test/api/offers/welcome", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));

beforeEach(() => {
  calls.consented = [];
  calls.stored = [];
  calls.signupOnly = [];
  state.promptsEnabled = true;
  state.sessionEmail = "shopper@example.test";
});

describe("only an explicit tick subscribes anybody", () => {
  it("records a consent when the caller says so", async () => {
    const res = await post({ phone: "5125550100", smsConsent: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, subscribed: true });
    expect(calls.consented).toHaveLength(1);
    expect(calls.stored).toHaveLength(0);
  });

  it("keeps the number and subscribes nobody when the field is missing", async () => {
    const body = await (await post({ phone: "5125550100" })).json();
    expect(body).toMatchObject({ ok: true, subscribed: false, phoneStored: true });
    expect(calls.stored).toHaveLength(1);
    expect(calls.consented, "a missing field subscribed somebody").toHaveLength(0);
  });

  it("keeps the number and subscribes nobody when the field is false", async () => {
    await post({ phone: "5125550100", smsConsent: false });
    expect(calls.stored).toHaveLength(1);
    expect(calls.consented).toHaveLength(0);
  });

  it("treats every truthy impostor as no", async () => {
    // "true", 1 and {} are what a caller sends by accident. None of them is a
    // person agreeing to be texted.
    for (const smsConsent of ["true", 1, {}, [], "yes"]) {
      await post({ phone: "5125550100", smsConsent });
    }
    expect(calls.consented, "a non-boolean was read as consent").toHaveLength(0);
    expect(calls.stored).toHaveLength(5);
  });
});

describe("the kill switch still decides what a real tick produces", () => {
  it("records consent without a discount while prompts are off", async () => {
    state.promptsEnabled = false;
    await post({ phone: "5125550100", smsConsent: true });
    expect(calls.signupOnly).toHaveLength(1);
    expect(calls.stored).toHaveLength(0);
  });

  it("does not consult the switch for a number with no tick", async () => {
    // Keeping a number is not a marketing prompt, so the prompt switch has no
    // business deciding it.
    state.promptsEnabled = false;
    await post({ phone: "5125550100" });
    expect(calls.stored).toHaveLength(1);
    expect(calls.signupOnly).toHaveLength(0);
  });
});

describe("every caller in the tree states its intent", () => {
  it("the checkout and the storefront form both send smsConsent true", async () => {
    // A caller that forgot the field would silently stop recording consent,
    // and nothing would look wrong.
    const { readFileSync } = await import("node:fs");
    const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");
    const checkout = read("app/checkout/page.tsx");
    const form = read("components/welcome-offer-signup.tsx");
    for (const [name, source] of [["checkout", checkout], ["signup form", form]] as const) {
      const post = source.slice(source.indexOf('"/api/offers/welcome"', source.indexOf("method: \"POST\"") - 200));
      expect(source, `${name} no longer states its consent`).toContain("smsConsent: true");
      expect(post.length).toBeGreaterThan(0);
    }
  });
});
