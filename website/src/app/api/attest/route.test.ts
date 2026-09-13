import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// THE ACT, AND EVERY WAY IT MUST REFUSE.
//
// This endpoint is public and it writes a legal representation, so the
// interesting assertions are the refusals. Read the file as a list of things
// that must NOT be possible:
//
//   * recording an attestation nobody explicitly made;
//   * recording one against an address the caller chose;
//   * granting anything before the statements are made, or after a refused
//     write, or to somebody with no account to write against;
//   * turning into a general-purpose way past the login wall.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
process.env.UNSUBSCRIBE_SECRET = "test-attestation-secret";

const state = vi.hoisted(() => ({
  outcome: "recorded" as "recorded" | "already" | "no_account" | "failed",
  /** Addresses recordAttestationForEmail was asked about. */
  asked: [] as string[],
  allowed: true,
}));

vi.mock("@/lib/email/attestation-record", () => ({
  recordAttestationForEmail: async (email: string) => {
    state.asked.push(email);
    return state.outcome;
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: state.allowed, retryAfterSeconds: 600 }),
}));
vi.mock("@/lib/request-ip", () => ({ rateLimitKeyForRequest: () => "attest:test" }));

const { POST } = await import("@/app/api/attest/route");
const { signAttestationHandoff } = await import("@/lib/email/attestation-handoff");
const { EMAIL_GRANT_COOKIE } = await import("@/lib/email/link-grant");
const { OFFER_COOKIE } = await import("@/lib/offers/customer-offers");

const post = (body: unknown) =>
  POST(new NextRequest("https://vanta.test/api/attest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

let handoff: string;
beforeEach(async () => {
  state.outcome = "recorded";
  state.asked = [];
  state.allowed = true;
  handoff = (await signAttestationHandoff({
    email: "lapsed@example.test",
    destination: "/products?utm_source=email",
    offerToken: "tok-gift",
  }))!;
});

describe("the happy path", () => {
  it("records the attestation and returns the exact destination the email meant", async () => {
    const response = await post({ h: handoff, ageConfirmed: true, researchUseOnly: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, destination: "/products?utm_source=email" });
    expect(state.asked).toEqual(["lapsed@example.test"]);
  });

  it("mints the ordinary marketing-link grant, and re-arms the gift", async () => {
    const response = await post({ h: handoff, ageConfirmed: true, researchUseOnly: true });
    const grant = response.cookies.get(EMAIL_GRANT_COOKIE);
    expect(grant?.value).toMatch(/^v1\./);
    expect(grant?.httpOnly).toBe(true);
    // The gift is a bearer secret: httpOnly cookie, never the URL.
    expect(response.cookies.get(OFFER_COOKIE)?.value).toBe("tok-gift");
    expect(response.cookies.get(OFFER_COOKIE)?.httpOnly).toBe(true);
  });

  it("grants an ALREADY-attested address without re-stamping the record", async () => {
    state.outcome = "already";
    const response = await post({ h: handoff, ageConfirmed: true, researchUseOnly: true });
    expect(response.status).toBe(200);
    expect(response.cookies.get(EMAIL_GRANT_COOKIE)?.value).toBeTruthy();
  });
});

describe("what it refuses", () => {
  it("refuses unless BOTH statements are explicitly affirmed", async () => {
    for (const body of [
      { h: handoff, ageConfirmed: true, researchUseOnly: false },
      { h: handoff, ageConfirmed: false, researchUseOnly: true },
      { h: handoff },
      // Truthy is not affirmed. Only an explicit boolean true counts.
      { h: handoff, ageConfirmed: "yes", researchUseOnly: "yes" },
      { h: handoff, ageConfirmed: 1, researchUseOnly: 1 },
    ]) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(state.asked, JSON.stringify(body)).toHaveLength(0);
    }
  });

  it("asks about nothing at all when the statements are missing", async () => {
    // Checked BEFORE the signature, so a half-completed form cannot advance the
    // flow by even one step.
    await post({ h: handoff, ageConfirmed: true, researchUseOnly: false });
    expect(state.asked).toHaveLength(0);
  });

  it("refuses a tampered, forged, absent or expired handoff with one answer", async () => {
    const parts = handoff.split(".");
    const tampered = [
      `${parts[0]}.${parts[1]}.${parts[2]}.${"0".repeat(32)}`,
      "nonsense",
      "",
      undefined,
    ];
    for (const h of tampered) {
      const response = await post({ h, ageConfirmed: true, researchUseOnly: true });
      expect(response.status, String(h)).toBe(400);
      expect((await response.json()).error).toMatch(/expired/i);
      expect(state.asked, String(h)).toHaveLength(0);
    }
  });

  it("cannot be pointed at a destination the grant could not open", async () => {
    // Otherwise attesting would become a way to reach somewhere the capability
    // it ends in was never allowed to reach.
    const sneaky = (await signAttestationHandoff({ email: "lapsed@example.test", destination: "/account/orders" }))!;
    const response = await post({ h: sneaky, ageConfirmed: true, researchUseOnly: true });
    expect(response.status).toBe(400);
  });

  it("writes against the address in the SIGNATURE, never one from the body", async () => {
    const response = await post({
      h: handoff,
      ageConfirmed: true,
      researchUseOnly: true,
      email: "victim@example.test",
    });
    expect(response.status).toBe(200);
    expect(state.asked).toEqual(["lapsed@example.test"]);
  });

  it("grants NOTHING to an address with no account, and sends them to sign up", async () => {
    // There is nowhere authoritative to write for someone with no auth record,
    // so they make the statements on the ordinary form. The destination rides
    // along and the gift is already in its cookie from the click.
    state.outcome = "no_account";
    const response = await post({ h: handoff, ageConfirmed: true, researchUseOnly: true });
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, needsAccount: true });
    expect(body.destination).toContain("/account/login?next=");
    expect(response.cookies.get(EMAIL_GRANT_COOKIE)).toBeUndefined();
  });

  it("grants nothing when the record could not be written", async () => {
    state.outcome = "failed";
    const response = await post({ h: handoff, ageConfirmed: true, researchUseOnly: true });
    expect(response.status).toBe(503);
    expect(response.cookies.get(EMAIL_GRANT_COOKIE)).toBeUndefined();
  });

  it("refuses a malformed body without touching anything", async () => {
    const response = await POST(new NextRequest("https://vanta.test/api/attest", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
    }));
    expect(response.status).toBe(400);
    expect(state.asked).toHaveLength(0);
  });

  it("is rate limited like every other public form here", async () => {
    state.allowed = false;
    const response = await post({ h: handoff, ageConfirmed: true, researchUseOnly: true });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("600");
    expect(state.asked).toHaveLength(0);
  });
});
