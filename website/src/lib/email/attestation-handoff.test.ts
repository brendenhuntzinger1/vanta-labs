import { beforeEach, describe, expect, it } from "vitest";
import {
  ATTESTATION_HANDOFF_TTL_MS,
  isValidHandoffDestination,
  signAttestationHandoff,
  verifyAttestationHandoff,
} from "@/lib/email/attestation-handoff";

// ---------------------------------------------------------------------------
// THE HANDOFF IS NOT A CREDENTIAL, AND THESE ARE THE PROPERTIES THAT KEEP IT
// FROM BECOMING ONE.
//
// It carries a clicker to the attestation step and back without losing the
// offer. On its own it opens nothing: it does not attest, does not grant, and
// cannot be pointed anywhere the grant it ends in could not have reached.
//
// It differs from link-grant.ts in one deliberate way — it names an address —
// because it ends in a compliance record written against a named account, and
// the account must be named by the signature rather than by anything the
// browser could choose.
// ---------------------------------------------------------------------------

process.env.UNSUBSCRIBE_SECRET = "test-attestation-secret";

/** Stands in for emailGrantAllowsPath: the grant's own closed allowlist. */
const allows = (pathname: string) =>
  ["/products", "/cart", "/checkout"].some((p) => pathname === p || pathname.startsWith(`${p}/`));

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const base = { email: "Guest@Example.Test", destination: "/products", offerToken: "tok-abc" };

let token: string;
beforeEach(async () => {
  token = (await signAttestationHandoff(base, NOW))!;
});

describe("a well-formed handoff", () => {
  it("round-trips the address, destination and offer", async () => {
    const out = await verifyAttestationHandoff(token, { allows, now: NOW + 1_000 });
    expect(out).toMatchObject({
      email: "guest@example.test", // normalised, so one address is one account
      destination: "/products",
      offerToken: "tok-abc",
    });
    expect(out!.nonce).toBeTruthy();
  });

  it("mints a fresh nonce each time, so two links are two uses", async () => {
    const a = await verifyAttestationHandoff(token, { allows, now: NOW + 1 });
    const second = (await signAttestationHandoff(base, NOW))!;
    const b = await verifyAttestationHandoff(second, { allows, now: NOW + 1 });
    expect(a!.nonce).not.toBe(b!.nonce);
  });

  it("carries no offer when the link had none", async () => {
    const noGift = (await signAttestationHandoff({ ...base, offerToken: null }, NOW))!;
    const out = await verifyAttestationHandoff(noGift, { allows, now: NOW + 1 });
    expect(out!.offerToken).toBeNull();
  });
});

describe("a handoff that must fail safely", () => {
  it("refuses a tampered address — the whole reason the address is signed", async () => {
    // Swap the payload for one naming somebody else. If this ever passes, a
    // forwarded link could write a representation against another person's
    // account, which is far worse than the browse capability it ends in.
    const [v, exp, , mac] = token.split(".");
    const evil = btoa(JSON.stringify({ e: "victim@example.test", d: "/products", o: null, n: "x" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyAttestationHandoff(`${v}.${exp}.${evil}.${mac}`, { allows, now: NOW + 1 })).toBeNull();
  });

  it("refuses a flipped signature byte", async () => {
    const parts = token.split(".");
    parts[3] = parts[3].startsWith("a") ? `b${parts[3].slice(1)}` : `a${parts[3].slice(1)}`;
    expect(await verifyAttestationHandoff(parts.join("."), { allows, now: NOW + 1 })).toBeNull();
  });

  it("refuses an expired handoff", async () => {
    expect(await verifyAttestationHandoff(token, { allows, now: NOW + ATTESTATION_HANDOFF_TTL_MS + 1 })).toBeNull();
  });

  it("refuses one stamped further out than the TTL allows", async () => {
    // Not ours, whatever it says about itself.
    const far = (await signAttestationHandoff(base, NOW + 10 * ATTESTATION_HANDOFF_TTL_MS))!;
    expect(await verifyAttestationHandoff(far, { allows, now: NOW })).toBeNull();
  });

  it("refuses a wrong version, a malformed shape, and an empty token", async () => {
    expect(await verifyAttestationHandoff(`v2.${token.split(".").slice(1).join(".")}`, { allows, now: NOW + 1 })).toBeNull();
    expect(await verifyAttestationHandoff("nonsense", { allows, now: NOW + 1 })).toBeNull();
    expect(await verifyAttestationHandoff("", { allows, now: NOW + 1 })).toBeNull();
    expect(await verifyAttestationHandoff(null, { allows, now: NOW + 1 })).toBeNull();
  });

  it("refuses a destination the grant itself could not open", async () => {
    // The handoff must not become a way to reach somewhere the capability it
    // ends in was never allowed to reach.
    const sneaky = (await signAttestationHandoff({ ...base, destination: "/account/orders" }, NOW))!;
    expect(await verifyAttestationHandoff(sneaky, { allows, now: NOW + 1 })).toBeNull();
  });

  it("refuses an absolute or protocol-relative destination — no open redirect", async () => {
    for (const destination of ["https://evil.test/x", "//evil.test/x", "/\\evil.test", "javascript:alert(1)"]) {
      expect(isValidHandoffDestination(destination, allows), destination).toBe(false);
      expect(await signAttestationHandoff({ ...base, destination }, NOW)
        .then((t) => (t ? verifyAttestationHandoff(t, { allows, now: NOW + 1 }) : null))).toBeNull();
    }
  });

  it("re-checks the destination on the way out, not only on the way in", async () => {
    // A path that was allowed when the link was minted must still be allowed
    // when it is used — the allowlist can change between the two.
    const narrower = (pathname: string) => pathname === "/cart";
    expect(await verifyAttestationHandoff(token, { allows: narrower, now: NOW + 1 })).toBeNull();
  });

  it("refuses an address-shaped nothing", async () => {
    expect(await signAttestationHandoff({ ...base, email: "" }, NOW)).toBeNull();
    expect(await signAttestationHandoff({ ...base, email: "not-an-address" }, NOW)).toBeNull();
  });
});

describe("what the handoff deliberately is not", () => {
  it("verifying does not spend the nonce", async () => {
    // The caller spends it at the moment it ACTS. A customer who opens the
    // interstitial and reads it has not silently burned their own link.
    const first = await verifyAttestationHandoff(token, { allows, now: NOW + 1 });
    const second = await verifyAttestationHandoff(token, { allows, now: NOW + 2 });
    expect(first!.nonce).toBe(second!.nonce);
  });

  it("is inert on its own: it carries no grant and no attestation", async () => {
    const out = await verifyAttestationHandoff(token, { allows, now: NOW + 1 });
    expect(Object.keys(out!).sort()).toEqual(["destination", "email", "nonce", "offerToken"]);
  });
});
