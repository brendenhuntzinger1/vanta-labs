import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THREE LANDINGS, NOT TWO.
//
// Both click trackers used to do one thing with "has this recipient attested":
// mint a grant, or not. "Or not" handed the customer a sign-in page — right for
// somebody who has never made the 21+ and research-use representations, and a
// dead end for the one holding a gift we had just minted and promised them.
//
// The third landing is the interstitial. The thing to hold on to reading these
// tests is that NO GRANT travels with it: the capability is minted on the far
// side, by POST /api/attest, only after the statements are actually made.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
process.env.UNSUBSCRIBE_SECRET = "test-attestation-secret";

const state = vi.hoisted(() => ({ attested: false, rpcError: null as { message: string } | null }));

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    rpc: async () => (state.rpcError
      ? { data: null, error: state.rpcError }
      : { data: state.attested, error: null }),
  },
}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://vanta.test" }));

const { emailLinkLanding } = await import("@/lib/email/recipient-attestation");
const { verifyAttestationHandoff } = await import("@/lib/email/attestation-handoff");
const { emailGrantAllowsPath } = await import("@/lib/email/link-grant");

const PRODUCTS = "https://vanta.test/products?utm_source=email&utm_campaign=winback_60";

beforeEach(() => {
  state.attested = false;
  state.rpcError = null;
});

describe("an attested recipient", () => {
  it("lands exactly where the email meant, carrying the grant", async () => {
    state.attested = true;
    const landing = await emailLinkLanding({ email: "member@example.test", destination: PRODUCTS });
    expect(landing.destination).toBe(PRODUCTS);
    expect(landing.grant).toMatch(/^v1\./);
  });

  it("sees no new screen and no new tap — nothing about their journey changed", async () => {
    state.attested = true;
    const landing = await emailLinkLanding({ email: "member@example.test", destination: PRODUCTS, offerToken: "tok" });
    expect(landing.destination).not.toContain("/attest");
  });
});

describe("a recipient who has never attested", () => {
  it("is sent to the step that collects the statements, with NO grant", async () => {
    const landing = await emailLinkLanding({ email: "lapsed@example.test", destination: PRODUCTS });
    expect(landing.grant).toBeNull();
    expect(new URL(landing.destination).pathname).toBe("/attest");
  });

  it("carries the address, the exact destination and the gift through it", async () => {
    const landing = await emailLinkLanding({
      email: "Lapsed@Example.TEST",
      destination: PRODUCTS,
      offerToken: "tok-gift",
    });
    const handoff = await verifyAttestationHandoff(
      new URL(landing.destination).searchParams.get("h"),
      { allows: emailGrantAllowsPath },
    );
    expect(handoff).toMatchObject({
      email: "lapsed@example.test",
      destination: "/products?utm_source=email&utm_campaign=winback_60",
      offerToken: "tok-gift",
    });
  });

  it("does not detour for a destination the grant could not have opened anyway", async () => {
    // Attesting does not get anybody to an account page, so routing them
    // through a screen that ends in a grant would promise a second dead end.
    const landing = await emailLinkLanding({
      email: "lapsed@example.test",
      destination: "https://vanta.test/account/orders",
    });
    expect(landing.destination).toBe("https://vanta.test/account/orders");
    expect(landing.grant).toBeNull();
  });
});

describe("when something underneath is broken", () => {
  it("treats an unreadable attestation lookup as not attested", async () => {
    // recipientHasAttested fails closed and this inherits it: the customer
    // reaches the step that asks, not an ungated catalogue.
    state.rpcError = { message: "connection reset" };
    const landing = await emailLinkLanding({ email: "anyone@example.test", destination: PRODUCTS });
    expect(landing.grant).toBeNull();
    expect(new URL(landing.destination).pathname).toBe("/attest");
  });

  it("degrades to the OLD behaviour when no handoff can be signed", async () => {
    // No secret means no handoff. That must land on the destination with no
    // grant — the sign-in page, exactly as before any of this existed — and
    // never on an ungated catalogue.
    const secret = process.env.UNSUBSCRIBE_SECRET;
    const role = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.UNSUBSCRIBE_SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const landing = await emailLinkLanding({ email: "lapsed@example.test", destination: PRODUCTS });
      expect(landing.destination).toBe(PRODUCTS);
      expect(landing.grant).toBeNull();
    } finally {
      if (secret) process.env.UNSUBSCRIBE_SECRET = secret;
      if (role) process.env.SUPABASE_SERVICE_ROLE_KEY = role;
    }
  });
});
