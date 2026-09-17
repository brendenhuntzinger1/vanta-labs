import { beforeAll, describe, expect, it } from "vitest";

import { SPIN_TOKEN_TTL_MS, signSpinToken, verifySpinToken } from "@/lib/spin/spin-token";

// ---------------------------------------------------------------------------
// THE LINK IN THE EMAIL, AND WHY IT IS SIGNED RATHER THAN LOOKED UP.
//
// The token says "this address may spin in this campaign". It grants no
// product on its own — the prize is minted server-side when they actually
// spin, into a customer_offers row bound to this same address — so it is a
// claim of identity, not a bearer capability over anything of value.
//
// Signed rather than stored so the sweep can address a hundred thousand emails
// without writing a hundred thousand rows for people who never open them. The
// row appears when someone spins.
//
// It DOES carry an address in the URL, which the offer token deliberately never
// does (see OFFER_COOKIE). That is the trade: this one cannot be exchanged for
// a vial by anyone who reads a Referer header, and the offer token can.
// ---------------------------------------------------------------------------

const CAMPAIGN = "spin_winback_2026q4";

beforeAll(() => {
  process.env.UNSUBSCRIBE_SECRET ??= "test-secret-for-spin-tokens";
});

describe("signing and verifying a spin link", () => {
  it("round-trips the address and the campaign", async () => {
    const token = await signSpinToken("Buyer@Example.com", CAMPAIGN);
    expect(token).toBeTruthy();

    const verified = await verifySpinToken(token);
    expect(verified).toEqual({ email: "buyer@example.com", campaignId: CAMPAIGN });
  });

  it("survives the addresses that break naive separators", async () => {
    // A dot is the field separator in the cart-recovery grant this is modelled
    // on, and every email address contains one. Plus-addressing and hyphens are
    // the other two that routinely break hand-rolled encodings.
    for (const address of [
      "first.last@example.co.uk",
      "buyer+spin-wheel@example.com",
      "a.b.c.d@sub.domain.example.com",
    ]) {
      const token = await signSpinToken(address, CAMPAIGN);
      expect((await verifySpinToken(token))?.email, address).toBe(address.toLowerCase());
    }
  });

  it("refuses a token whose signature was edited", async () => {
    const token = (await signSpinToken("buyer@example.com", CAMPAIGN))!;
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    expect(await verifySpinToken(tampered)).toBeNull();
  });

  it("refuses a token whose address was swapped for someone else's", async () => {
    // The attack this exists to stop: take your own link, put the address of a
    // customer who has not span yet in it, and spend their spin.
    const mine = (await signSpinToken("me@example.com", CAMPAIGN))!;
    const parts = mine.split(".");
    parts[1] = Buffer.from("victim@example.com").toString("base64url");
    expect(await verifySpinToken(parts.join("."))).toBeNull();
  });

  it("refuses a token whose campaign was swapped", async () => {
    const token = (await signSpinToken("buyer@example.com", CAMPAIGN))!;
    const parts = token.split(".");
    parts[2] = Buffer.from("spin_winback_2027q1").toString("base64url");
    expect(await verifySpinToken(parts.join("."))).toBeNull();
  });

  it("refuses an expired link", async () => {
    const mintedAt = Date.now() - SPIN_TOKEN_TTL_MS - 1_000;
    const token = (await signSpinToken("buyer@example.com", CAMPAIGN, mintedAt))!;
    expect(await verifySpinToken(token)).toBeNull();
  });

  it("refuses a link stamped further out than the scheme allows", async () => {
    // A forged expiry is caught by the signature anyway; this is the cheaper
    // check that stops one being honoured if the secret ever leaks and is
    // rotated — an attacker cannot mint a decade-long link under the old key
    // and have it still accepted.
    const token = (await signSpinToken("buyer@example.com", CAMPAIGN, Date.now() + SPIN_TOKEN_TTL_MS))!;
    expect(await verifySpinToken(token)).toBeNull();
  });

  it("refuses malformed input without distinguishing why", async () => {
    for (const bad of ["", "   ", "nonsense", "v1.only.three.parts", "v2.a.b.c.d", "x".repeat(600), null, undefined]) {
      expect(await verifySpinToken(bad as string), String(bad)).toBeNull();
    }
  });

  it("will not sign an address that is not one", async () => {
    for (const bad of ["", "   ", "not-an-address"]) {
      expect(await signSpinToken(bad, CAMPAIGN), bad).toBeNull();
    }
  });
});
