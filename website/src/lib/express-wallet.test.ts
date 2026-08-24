import { describe, expect, it } from "vitest";
import {
  addressFingerprint,
  fingerprintFromShippingMethodId,
  hasAllAcknowledgements,
  resolveWalletName,
  secretsMatch,
  shippingMethodId,
} from "@/lib/express-wallet";

// The fingerprint is the whole anti-tamper story for the express lane's tax:
// it is computed twice, from two DIFFERENT shapes of the same address (the
// redacted contact the wallet exposes before authorization, and the full one it
// hands over with it). If those two ever disagree for one address, every
// legitimate charge is refused; if they agree for two DIFFERENT addresses, a
// stale quote can be spent on the wrong one.
describe("addressFingerprint", () => {
  it("matches across the redacted pre-auth contact and the full wallet contact", () => {
    const preAuth = { country: "US", state: "TX", city: "Austin", postal_code: "78701" };
    const atAuth = { country: "US", state: "TX", city: "Austin", postal_code: "78701-1234" };
    expect(addressFingerprint(atAuth)).toBe(addressFingerprint(preAuth));
  });

  it("ignores case and whitespace variance the wallet introduces", () => {
    const a = { country: "US", state: "TX", city: "San  Antonio", postal_code: "78205" };
    const b = { country: "us", state: "tx", city: " san antonio ", postal_code: "78205" };
    expect(addressFingerprint(a)).toBe(addressFingerprint(b));
  });

  it("normalises a Canadian postal code with or without its space", () => {
    const spaced = { country: "CA", state: "ON", city: "Ottawa", postal_code: "K1A 0B1" };
    const tight = { country: "CA", state: "ON", city: "Ottawa", postal_code: "K1A0B1" };
    expect(addressFingerprint(spaced)).toBe(addressFingerprint(tight));
  });

  it("differs when the tax-relevant destination differs", () => {
    const texas = { country: "US", state: "TX", city: "Austin", postal_code: "78701" };
    const florida = { country: "US", state: "FL", city: "Austin", postal_code: "78701" };
    const otherZip = { country: "US", state: "TX", city: "Austin", postal_code: "77002" };
    expect(addressFingerprint(texas)).not.toBe(addressFingerprint(florida));
    expect(addressFingerprint(texas)).not.toBe(addressFingerprint(otherZip));
  });
});

describe("shippingMethodId", () => {
  it("round-trips the fingerprint prefix it embeds", () => {
    const fingerprint = addressFingerprint({ country: "US", state: "TX", city: "Austin", postal_code: "78701" });
    const id = shippingMethodId(fingerprint);
    expect(fingerprintFromShippingMethodId(id)).toBe(fingerprint.slice(0, 12));
  });

  it("stays inside the processor's id rules (<=80 chars, [A-Za-z0-9_-])", () => {
    const id = shippingMethodId(addressFingerprint({ country: "US", state: "NY", city: "Queens", postal_code: "11101" }));
    expect(id.length).toBeLessThanOrEqual(80);
    expect(/^[A-Za-z0-9_-]+$/.test(id)).toBe(true);
  });

  it("rejects an id that is not one of ours", () => {
    expect(fingerprintFromShippingMethodId("veyra_fallback_free")).toBeNull();
    expect(fingerprintFromShippingMethodId("vl_std_NOTHEX000000")).toBeNull();
  });
});

// The wallet drops the family name on a meaningful share of orders. Recovering
// it matters because an unresolved name fails validateCustomer and refuses the
// charge — and because issuers decline a card-not-present charge with no
// cardholder identity.
describe("resolveWalletName", () => {
  it("prefers the billing contact over the shipping contact", () => {
    const resolved = resolveWalletName({
      billing: { firstName: "Alex", lastName: "Morgan" },
      shipping: { firstName: "Shipping", lastName: "Recipient" },
    });
    expect(resolved).toEqual({ firstName: "Alex", lastName: "Morgan" });
  });

  it("falls back to the shipping contact for a missing field", () => {
    const resolved = resolveWalletName({
      billing: { firstName: "Alex", lastName: "" },
      shipping: { firstName: "Alex", lastName: "Morgan" },
    });
    expect(resolved.lastName).toBe("Morgan");
  });

  it("splits a single-field wallet name", () => {
    const resolved = resolveWalletName({ billing: { firstName: "Alex Morgan", lastName: "" } });
    expect(resolved).toEqual({ firstName: "Alex", lastName: "Morgan" });
  });

  it("derives a last name from a firstname.lastname email as a last resort", () => {
    const resolved = resolveWalletName({
      billing: { firstName: "Alex", lastName: "" },
      email: "alex.morgan@example.com",
    });
    expect(resolved.lastName).toBe("Morgan");
  });

  it("never invents a name when there is no signal at all", () => {
    expect(resolveWalletName({ billing: {}, shipping: {}, email: "buyer@example.com" })).toEqual({
      firstName: "",
      lastName: "",
    });
  });
});

describe("secretsMatch", () => {
  it("accepts an exact match and rejects everything else", () => {
    expect(secretsMatch("s3cret-token", "s3cret-token")).toBe(true);
    expect(secretsMatch("s3cret-token", "s3cret-tokeN")).toBe(false);
    expect(secretsMatch("s3cret-token", "s3cret-token-longer")).toBe(false);
  });

  it("rejects an empty presented value, so an unset token never authenticates", () => {
    expect(secretsMatch("", "")).toBe(false);
    expect(secretsMatch("", "s3cret-token")).toBe(false);
  });
});

describe("hasAllAcknowledgements", () => {
  it("requires BOTH statements, strictly true", () => {
    // Two now: the three research/compliance statements were consolidated into
    // one on 2026-08-25. The card lane calls this same function, so a statement
    // can never be required in one lane and forgotten in the other.
    const all = { researchCompliance: true, returnsPolicy: true };
    expect(hasAllAcknowledgements(all)).toBe(true);

    // Dropping either one refuses the wallet session.
    for (const key of Object.keys(all)) {
      expect(hasAllAcknowledgements({ ...all, [key]: false })).toBe(false);
      const missing = Object.fromEntries(Object.entries(all).filter(([k]) => k !== key));
      expect(hasAllAcknowledgements(missing)).toBe(false);
    }

    // Truthy is not true — a "1" or "yes" must not pass for a legal consent.
    // This matters MORE now the boxes render pre-ticked: the default lives in
    // the UI and grants the server nothing.
    for (const impostor of [1, "yes", "true", {}, []]) {
      expect(hasAllAcknowledgements({ ...all, researchCompliance: impostor })).toBe(false);
      expect(hasAllAcknowledgements({ ...all, returnsPolicy: impostor })).toBe(false);
    }

    // The retired keys must not resurrect the old contract: sending only the
    // three old statements is exactly what broke card checkout before.
    expect(
      hasAllAcknowledgements({
        researchResponsibility: true,
        ageLegalConfirmation: true,
      }),
    ).toBe(false);
  });
});
