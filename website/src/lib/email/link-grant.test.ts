import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// THE DEFECT THIS EXISTS FOR.
//
// Checked read-only against production on 2026-09-08, signed out:
//
//   GET /products        307  /account/login?next=%2Fproducts
//   GET /cart            307  /account/login?next=%2Fcart
//   GET /account/orders  307  /account/login?next=%2Faccount%2Forders
//
// Those three are the ONLY cta_path values in production: campaigns point at
// /products, and the six retention automations at /products or /account/orders.
// /api/email/click is on the public list, so the click was recorded and the
// attribution cookie set — and then the shopper met a sign-in page. Cart
// recovery had the identical defect (F-0) and its fix was cart-scoped, so
// campaigns and automations never got one.
//
// The grant must not simply open the wall. The 21+ and research-use
// representations are two required tick boxes ON the sign-in form, so the wall
// and the age gate are one screen. That is why every test below about SCOPE
// matters as much as the ones about signatures: a capability that reached
// /account/orders would hand somebody another customer's order history, and one
// minted without the attestation check would put an unattested visitor in front
// of 21+ research-use-only material.
// ---------------------------------------------------------------------------

beforeAll(() => {
  process.env.UNSUBSCRIBE_SECRET ??= "test-secret-for-link-grants";
});

const grant = () => import("@/lib/email/link-grant");

describe("the token round trip", () => {
  it("verifies a grant it just minted", async () => {
    const { signEmailLinkGrant, verifyEmailLinkGrant } = await grant();
    const token = await signEmailLinkGrant();
    expect(token).toBeTruthy();
    expect(await verifyEmailLinkGrant(token)).not.toBeNull();
  });

  it("carries no identity — three fields, none of them an address", async () => {
    const { signEmailLinkGrant } = await grant();
    const token = (await signEmailLinkGrant())!;
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("v1");
    expect(token).not.toMatch(/@/);
  });
});

describe("what a tampered grant gets", () => {
  it("refuses an extended expiry, because the expiry is signed", async () => {
    const { signEmailLinkGrant, verifyEmailLinkGrant, EMAIL_GRANT_TTL_MS } = await grant();
    const [version, expiry, mac] = (await signEmailLinkGrant())!.split(".");
    const extended = `${version}.${Number(expiry) + EMAIL_GRANT_TTL_MS}.${mac}`;
    expect(await verifyEmailLinkGrant(extended)).toBeNull();
  });

  it("refuses an edited signature", async () => {
    const { signEmailLinkGrant, verifyEmailLinkGrant } = await grant();
    const [version, expiry, mac] = (await signEmailLinkGrant())!.split(".");
    const flipped = mac[0] === "0" ? `1${mac.slice(1)}` : `0${mac.slice(1)}`;
    expect(await verifyEmailLinkGrant(`${version}.${expiry}.${flipped}`)).toBeNull();
  });

  it("refuses one that has expired", async () => {
    const { signEmailLinkGrant, verifyEmailLinkGrant, EMAIL_GRANT_TTL_MS } = await grant();
    const now = Date.now();
    const token = await signEmailLinkGrant(now);
    expect(await verifyEmailLinkGrant(token, now + EMAIL_GRANT_TTL_MS + 1)).toBeNull();
  });

  // A grant stamped further out than the TTL permits was not minted here, even
  // if the signature somehow matched — belt and braces against a future change
  // that lengthens the TTL and leaves old long-dated tokens honoured.
  it("refuses one stamped beyond the ceiling", async () => {
    const { signEmailLinkGrant, verifyEmailLinkGrant, EMAIL_GRANT_TTL_MS } = await grant();
    const now = Date.now();
    const token = await signEmailLinkGrant(now + EMAIL_GRANT_TTL_MS);
    expect(await verifyEmailLinkGrant(token, now)).toBeNull();
  });

  it.each([
    ["", "empty"],
    ["v1", "no fields"],
    ["v1.123", "two fields"],
    ["v1.123.abc.def", "four fields"],
    ["v2.9999999999999.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "wrong version"],
    ["v1.notanumber.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "expiry is not a number"],
    ["v1.1.7e9.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "expiry in exponent form"],
  ])("refuses %o (%s)", async (token) => {
    const { verifyEmailLinkGrant } = await grant();
    expect(await verifyEmailLinkGrant(token)).toBeNull();
  });

  it("refuses an absurdly long value without hashing it", async () => {
    const { verifyEmailLinkGrant } = await grant();
    expect(await verifyEmailLinkGrant(`v1.${Date.now() + 1000}.${"a".repeat(5000)}`)).toBeNull();
  });
});

// The two grants sign with the SAME secret. Without the namespace prefix inside
// the signed payload, a token minted for one could verify as the other — and
// the cart grant is minted for guests with no attestation at all, so a cart
// token verifying as a browse grant would be exactly the compliance hole this
// design exists to avoid.
describe("the two grant families are disjoint", () => {
  it("a cart-recovery grant does not verify as a marketing-link grant", async () => {
    const { verifyEmailLinkGrant } = await grant();
    const { signGuestRecoveryGrant } = await import("@/lib/cart-recovery-grant");
    const cartToken = await signGuestRecoveryGrant("11111111-2222-3333-4444-555555555555");
    expect(await verifyEmailLinkGrant(cartToken)).toBeNull();
  });

  it("a marketing-link grant does not verify as a cart-recovery grant", async () => {
    const { signEmailLinkGrant } = await grant();
    const { verifyGuestRecoveryGrant } = await import("@/lib/cart-recovery-grant");
    expect(await verifyGuestRecoveryGrant(await signEmailLinkGrant())).toBeNull();
  });
});

describe("what a grant unlocks", () => {
  it.each([
    "/",
    "/products",
    "/products/glp-3",
    "/research",
    "/research/bac-water-handling",
    "/cart",
    "/checkout",
    "/api/cart/validate",
    "/api/checkout/create-session",
    "/api/catalog/promotions",
    "/order-confirmation/abc-123",
  ])("covers %s, which the click-to-purchase journey needs", async (pathname) => {
    const { emailGrantAllowsPath } = await grant();
    expect(emailGrantAllowsPath(pathname)).toBe(true);
  });

  // Each of these is somebody's private data or somebody's console. A browse
  // capability minted from an email link must not be a key to any of them.
  it.each([
    "/account",
    "/account/orders",
    "/account/settings",
    "/account/addresses",
    "/api/account/me",
    "/api/account/orders",
    "/admin",
    "/admin/orders",
    "/api/admin/products",
    "/vault",
    "/partner/dashboard",
    "/api/partner/commissions",
  ])("does NOT cover %s", async (pathname) => {
    const { emailGrantAllowsPath } = await grant();
    expect(emailGrantAllowsPath(pathname)).toBe(false);
  });

  // A prefix match that forgot its trailing slash is the classic way an
  // allowlist leaks: "/products" as a bare prefix would also admit
  // "/products-admin" and "/productsecret".
  it.each(["/products-admin", "/researchers", "/accountant"])(
    "does not admit %o through a sloppy prefix", async (pathname) => {
      const { emailGrantAllowsPath } = await grant();
      expect(emailGrantAllowsPath(pathname)).toBe(false);
    });
});

describe("ctaPathReachesStore, for the composer's warning", () => {
  it("says yes for the destination every campaign uses", async () => {
    const { ctaPathReachesStore } = await grant();
    expect(ctaPathReachesStore("/products")).toBe(true);
  });

  // post_purchase and replenishment both point here in production. It is a
  // legitimate destination and it WILL ask for a sign-in; the composer's job is
  // to say so before Send, not after the click-to-order rate says it.
  it("says no for /account/orders, which two automations point at", async () => {
    const { ctaPathReachesStore } = await grant();
    expect(ctaPathReachesStore("/account/orders")).toBe(false);
  });

  it("ignores a query string and a fragment", async () => {
    const { ctaPathReachesStore } = await grant();
    expect(ctaPathReachesStore("/products?sort=new#top")).toBe(true);
  });

  it.each([null, undefined, "", "https://evil.com/products", "products"])(
    "says no for %o", async (value) => {
      const { ctaPathReachesStore } = await grant();
      expect(ctaPathReachesStore(value as string)).toBe(false);
    });
});

describe("reading the cookie off a request", () => {
  it("finds the grant among other cookies", async () => {
    const { readEmailGrantCookie, EMAIL_GRANT_COOKIE } = await grant();
    const request = new Request("https://example.test/", {
      headers: { cookie: `vl_campaign=abc; ${EMAIL_GRANT_COOKIE}=v1.123.deadbeef; other=1` },
    });
    expect(readEmailGrantCookie(request)).toBe("v1.123.deadbeef");
  });

  it.each([
    ["", "no cookie header"],
    ["vl_cart_grant=v1.x.1.y", "only the other grant"],
    ["vl_email_grant_extra=nope", "a name that merely starts the same"],
  ])("returns null for %o (%s)", async (cookie) => {
    const { readEmailGrantCookie } = await grant();
    const request = new Request("https://example.test/", { headers: cookie ? { cookie } : {} });
    expect(readEmailGrantCookie(request)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE WALL'S ORDERING IS A SECURITY PROPERTY, SO IT IS PINNED IN THE SOURCE.
//
// Same technique access-policy.test.ts already uses. A grant consulted BEFORE
// the session check would make every signed-in request pay for an HMAC; one
// consulted before the path check would verify signatures for /api/admin. The
// order below is the blast radius.
// ---------------------------------------------------------------------------
describe("middleware consults the grant last, and the path first", () => {
  const source = readFileSync(path.resolve(__dirname, "../../../middleware.ts"), "utf8");
  const flat = source.replace(/\s+/g, " ");

  it("checks session, admin session and the cart grant before this one", () => {
    expect(flat).toContain(
      "requiresAccount(pathname) && !(await sessionIsVerified()) "
      + "&& !(await hasValidAdminSession(request)) "
      + "&& !(await hasGuestCartGrant(request, pathname)) "
      + "&& !(await hasEmailLinkGrant(request, pathname))",
    );
  });

  it("checks the path allowlist before it verifies any signature", () => {
    const fn = flat.slice(
      flat.indexOf("async function hasEmailLinkGrant"),
      flat.indexOf("async function hasValidAdminSession"),
    );
    expect(fn.indexOf("emailGrantAllowsPath")).toBeLessThan(fn.indexOf("verifyEmailLinkGrant"));
  });

  // A query-parameter form would end up in Referer headers and shared links.
  // The cart grant accepts one on two named restore paths for a specific
  // reason; a browse capability has no equivalent reason.
  it("accepts the grant from a cookie only, never from the URL", () => {
    const fn = flat.slice(
      flat.indexOf("async function hasEmailLinkGrant"),
      flat.indexOf("async function hasValidAdminSession"),
    );
    expect(fn).not.toContain("searchParams");
  });
});
