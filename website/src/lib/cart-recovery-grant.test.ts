import { beforeAll, describe, expect, it } from "vitest";
import {
  GUEST_GRANT_COOKIE,
  GUEST_GRANT_EXACT,
  GUEST_GRANT_TTL_MS,
  guestGrantAllowsPath,
  readGuestGrantCookie,
  signGuestRecoveryGrant,
  verifyGuestRecoveryGrant,
} from "@/lib/cart-recovery-grant";

// ---------------------------------------------------------------------------
// THE GRANT IS A CAPABILITY FOR ONE CART, NOT A SESSION.
//
// Most recovery recipients are guests who typed an email into the checkout
// field and never made an account. The store is account-only by default, so the
// recovery email tracked their click — the tracker is public — and then handed
// them a sign-in page for an account they do not have. The programme could
// record a click and could never record a conversion.
//
// The obvious shortcut was to treat the cart UUID as the credential. It is
// rejected here on purpose: a database key appears in admin screens, logs,
// support threads and CSV exports, and it never expires, so anyone who ever saw
// one could open that cart forever.
//
// Every property below is one an attacker would want to break, and each is
// tested with the attack rather than with a happy path.
// ---------------------------------------------------------------------------

beforeAll(() => {
  process.env.UNSUBSCRIBE_SECRET ??= "test-secret-for-cart-recovery-grants";
});

const CART = "70c07050-1b3b-43d2-84bc-703dbb6e173f";
const OTHER = "0f6c55a8-4b1c-4f8d-891a-f55344aec180";

describe("a grant round-trips and names exactly one cart", () => {
  it("verifies and returns the cart it was minted for", async () => {
    const now = Date.now();
    const token = (await signGuestRecoveryGrant(CART, now))!;
    expect(await verifyGuestRecoveryGrant(token, now)).toEqual({
      cartId: CART,
      expiresAtMs: now + GUEST_GRANT_TTL_MS,
    });
  });

  it("does not name any other cart", async () => {
    const token = (await signGuestRecoveryGrant(CART))!;
    expect((await verifyGuestRecoveryGrant(token))!.cartId).not.toBe(OTHER);
  });
});

describe("tampering", () => {
  // THE POINT OF THE WHOLE FILE. Swap the cart id and the signature no longer
  // covers the payload, so the grant for one shopper's cart cannot be pointed
  // at another's.
  it("a grant repointed at a different cart does not verify", async () => {
    const token = (await signGuestRecoveryGrant(CART))!;
    const parts = token.split(".");
    const forged = [parts[0], OTHER, parts[2], parts[3]].join(".");
    expect(await verifyGuestRecoveryGrant(forged)).toBeNull();
  });

  it("an extended expiry does not verify, so a lifetime cannot be edited", async () => {
    const now = Date.now();
    const token = (await signGuestRecoveryGrant(CART, now))!;
    const parts = token.split(".");
    const forged = [parts[0], parts[1], String(now + GUEST_GRANT_TTL_MS - 1000), parts[3]].join(".");
    expect(await verifyGuestRecoveryGrant(forged, now)).toBeNull();
  });

  it.each([
    ["a flipped signature byte", (t: string) => {
      const p = t.split(".");
      const sig = p[3];
      p[3] = (sig[0] === "a" ? "b" : "a") + sig.slice(1);
      return p.join(".");
    }],
    ["a truncated signature", (t: string) => { const p = t.split("."); p[3] = p[3].slice(0, 16); return p.join("."); }],
    ["a lengthened signature", (t: string) => `${t}00`],
    ["an empty signature", (t: string) => { const p = t.split("."); p[3] = ""; return p.join("."); }],
    ["a bumped version", (t: string) => `v2.${t.split(".").slice(1).join(".")}`],
    ["an extra field", (t: string) => `${t}.extra`],
    ["a missing field", (t: string) => t.split(".").slice(0, 3).join(".")],
  ])("%s does not verify", async (_label, mutate) => {
    expect(await verifyGuestRecoveryGrant(mutate((await signGuestRecoveryGrant(CART))!))).toBeNull();
  });

  it.each([null, undefined, "", "   ", "garbage", "v1...", "a".repeat(500)])(
    "%o is not a grant", async (value) => {
      expect(await verifyGuestRecoveryGrant(value as string | null | undefined)).toBeNull();
    });

  // A non-numeric or fractional expiry would otherwise reach the HMAC as a
  // different string than the one signed; refusing early keeps the shape closed.
  it.each(["notanumber", "1.5e3", "Infinity", "NaN", ""])("an expiry of %o does not verify", async (expiry) => {
    const parts = (await signGuestRecoveryGrant(CART))!.split(".");
    expect(await verifyGuestRecoveryGrant([parts[0], parts[1], expiry, parts[3]].join("."))).toBeNull();
  });
});

describe("expiry", () => {
  it("refuses a grant one millisecond past its expiry", async () => {
    const now = Date.now();
    const token = (await signGuestRecoveryGrant(CART, now))!;
    expect(await verifyGuestRecoveryGrant(token, now + GUEST_GRANT_TTL_MS)).toBeNull();
    expect(await verifyGuestRecoveryGrant(token, now + GUEST_GRANT_TTL_MS - 1)).not.toBeNull();
  });

  it("still works on day four, which is when the last recovery email lands", async () => {
    const now = Date.now();
    const token = (await signGuestRecoveryGrant(CART, now))!;
    expect(await verifyGuestRecoveryGrant(token, now + 4 * 24 * 3_600_000)).not.toBeNull();
  });

  // A clock that has gone backwards, or a token minted against a different
  // clock, should not buy a longer life than the TTL allows.
  it("refuses a grant stamped further out than the TTL permits", async () => {
    const now = Date.now();
    const token = (await signGuestRecoveryGrant(CART, now + 60 * 24 * 3_600_000))!;
    expect(await verifyGuestRecoveryGrant(token, now)).toBeNull();
  });
});

describe("minting refuses what it cannot sign safely", () => {
  it.each([null, undefined, "", "   "])("%o mints nothing", async (id) => {
    expect(await signGuestRecoveryGrant(id as unknown as string)).toBeNull();
  });

  // The dot is the field separator. An id containing one would make the token
  // ambiguous to parse, which is a forgery surface rather than a nuisance.
  it("refuses a cart id containing the separator", async () => {
    expect(await signGuestRecoveryGrant("cart.with.dots")).toBeNull();
  });
});

describe("what a grant unlocks is a closed list", () => {
  it.each([
    "/cart", "/cart/restore", "/checkout",
    "/api/cart/restore", "/api/cart/validate", "/api/checkout/create-session",
  ])("%s is reachable, because the journey needs it", (path) => {
    expect(guestGrantAllowsPath(path)).toBe(true);
  });

  // THE LIST THAT MATTERS. A grant is a capability to finish one cart; if any
  // of these ever passes, it has become a key to the gated store.
  it.each([
    "/account", "/account/orders", "/account/profile",
    "/api/account/me", "/api/account/ambassador-discount",
    "/admin", "/api/admin/orders", "/vault",
    "/products", "/products/glp-3", "/", "/coa-library",
    "/api/partner", "/partner/dashboard",
    "/api/admin/checkout-preflight",
  ])("%s is NOT reachable with a grant", (path) => {
    expect(guestGrantAllowsPath(path)).toBe(false);
  });

  // A prefix that ended without its slash would match /cartography and
  // /paypal-anything. Each prefix carries its separator for that reason.
  it("does not let a prefix leak into a neighbouring path", () => {
    expect(guestGrantAllowsPath("/cartography")).toBe(false);
    expect(guestGrantAllowsPath("/checkoutlet")).toBe(false);
    expect(guestGrantAllowsPath("/paywall")).toBe(false);
  });

  it("grants the id-bearing pages that defend themselves with an unguessable id", () => {
    expect(guestGrantAllowsPath("/order-confirmation/order-abc")).toBe(true);
    expect(guestGrantAllowsPath("/checkout/pay/order-abc")).toBe(true);
  });

  it("never grants an account path, however the list is edited", async () => {
    for (const path of GUEST_GRANT_EXACT) {
      expect(path.startsWith("/account"), `${path} must not be grantable`).toBe(false);
      expect(path.startsWith("/api/account"), `${path} must not be grantable`).toBe(false);
      expect(path.startsWith("/admin"), `${path} must not be grantable`).toBe(false);
    }
  });
});

describe("the cookie", () => {
  it("is read off a request without picking up its neighbours", () => {
    const request = new Request("https://example.test", {
      headers: { cookie: `vl_offer=secret; ${GUEST_GRANT_COOKIE}=v1.abc.123.def; vl_campaign=c.1` },
    });
    expect(readGuestGrantCookie(request)).toBe("v1.abc.123.def");
  });

  it("returns null when absent", () => {
    expect(readGuestGrantCookie(new Request("https://example.test"))).toBeNull();
    expect(readGuestGrantCookie(new Request("https://example.test", { headers: { cookie: "vl_offer=x" } }))).toBeNull();
  });

  it("refuses an over-long value rather than passing it to the verifier", () => {
    const request = new Request("https://example.test", {
      headers: { cookie: `${GUEST_GRANT_COOKIE}=${"a".repeat(600)}` },
    });
    expect(readGuestGrantCookie(request)).toBeNull();
  });
});
