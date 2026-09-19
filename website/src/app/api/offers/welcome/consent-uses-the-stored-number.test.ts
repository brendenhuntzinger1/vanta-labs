import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A TICK WITH NO TYPED NUMBER IS STILL A CONSENT.
//
// The wheel stops asking for a number once the store holds one — retyping it
// buys nothing, and that stored number is exactly what a later tick is meant
// to subscribe. So the commonest shape of a consent, for anyone who has ever
// checked out, is a ticked box and an EMPTY phone field.
//
// The endpoint used to read that as "no number" and answer 400. The consent
// was given, the shopper was told nothing useful, and nobody was subscribed —
// which is the one direction this endpoint is not allowed to fail in, because
// a consent that is dropped cannot be recovered from any record.
//
// The number the tick subscribes is the store's own, read server-side. The
// body can never name a number the caller does not already possess.
// ---------------------------------------------------------------------------

const calls = vi.hoisted(() => ({
  consented: [] as Array<{ phone?: unknown }>,
  stored: [] as Array<{ phone?: unknown }>,
  signupOnly: [] as Array<{ phone?: unknown }>,
}));
const state = vi.hoisted(() => ({
  promptsEnabled: false,
  sessionEmail: "shopper@example.test" as string | null,
  onFile: "+15125550142" as string | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-control", () => ({
  getSmsSignupConfig: async () => ({ promptsEnabled: state.promptsEnabled, dismissCooldownDays: 7, holdoutPercent: 0 }),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedUser: async () => (state.sessionEmail ? { id: "user-1", email: state.sessionEmail } : null),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/request-ip", () => ({ rateLimitKeyForRequest: () => "k" }));
vi.mock("@/lib/sms-consent", () => ({
  phoneOnFileFor: async () => state.onFile,
}));
vi.mock("@/lib/offers/welcome-offer", () => ({
  readWelcomeOffer: async () => ({ status: "eligible", mayInterrupt: true }),
  claimWelcomeOffer: async (input: { phone?: unknown }) => { calls.consented.push(input); return { ok: true, subscribedOnly: true }; },
  recordSmsSignupOnly: async (input: { phone?: unknown }) => { calls.signupOnly.push(input); return true; },
  // Mirrors the real writer: a blank number is not one anybody could be
  // texted at, so it is refused rather than filed.
  recordPhoneWithoutConsent: async (input: { phone?: unknown }) => { calls.stored.push(input); return Boolean(String(input.phone ?? "").trim()); },
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
  state.promptsEnabled = false;
  state.sessionEmail = "shopper@example.test";
  state.onFile = "+15125550142";
});

describe("a tick with no typed number", () => {
  it("subscribes the number the store already holds", async () => {
    const res = await post({ smsConsent: true, placement: "storefront" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, subscribed: true });
    expect(calls.signupOnly, "the consent was dropped").toHaveLength(1);
    expect(calls.signupOnly[0]?.phone).toBe("+15125550142");
  });

  it("prefers a number the shopper did type, over the one on file", async () => {
    // They are being shown the field, so they are correcting or replacing it.
    await post({ smsConsent: true, phone: "512-555-0199", placement: "storefront" });
    expect(calls.signupOnly[0]?.phone).toBe("512-555-0199");
  });

  it("asks for a number when there is none to consent, rather than failing quietly", async () => {
    state.onFile = null;
    const res = await post({ smsConsent: true, placement: "storefront" });
    expect(res.status).toBe(400);
    const body = await res.json();
    // `needPhone` is what tells the card to reveal the field it had hidden.
    // Without it the shopper is told to enter something with nowhere to type.
    expect(body).toMatchObject({ ok: false, needPhone: true });
    expect(String(body.error)).toMatch(/number/i);
    expect(calls.signupOnly, "somebody was subscribed with no number").toHaveLength(0);
    expect(calls.consented).toHaveLength(0);
  });
});

describe("what the stored number does NOT change", () => {
  it("an untouched box still keeps the typed number and subscribes nobody", async () => {
    const body = await (await post({ phone: "5125550100", placement: "storefront" })).json();
    expect(body).toMatchObject({ ok: true, subscribed: false, phoneStored: true });
    expect(calls.stored).toHaveLength(1);
    expect(calls.signupOnly).toHaveLength(0);
  });

  it("an untouched box with no typed number files nothing and subscribes nobody", async () => {
    // Nothing was given and nothing was agreed to. The stored number is read
    // for a CONSENT and nothing else: it is never re-filed as a fresh
    // collection, which would write today's date over a real one.
    const res = await post({ placement: "storefront" });
    expect(res.status).toBe(400);
    expect(calls.stored.map((call) => call.phone), "the number on file was re-filed").not.toContain("+15125550142");
    expect(calls.signupOnly).toHaveLength(0);
    expect(calls.consented).toHaveLength(0);
  });
});
