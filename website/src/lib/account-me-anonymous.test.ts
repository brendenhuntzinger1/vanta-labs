import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { AUTH_COOKIE_NAME, decodeAuthCookie, encodeAuthCookie } from "@/lib/auth-cookie";
import { assertNotGutted, stripComments } from "@/lib/test-support/strip-comments";

// ---------------------------------------------------------------------------
// A LOGGED-OUT VISITOR DOES NOT ASK AN ACCOUNT ENDPOINT ABOUT AN ACCOUNT.
//
// /api/account/me returns a signed-in customer's email, full name and default
// address, and the checkout page uses that response to pre-fill the order form
// and to LOCK the order email to the account. It is account data, so it 401s
// for anonymous callers exactly like every other /api/account/* route, and that
// must not change.
//
// What changed is that the client stopped asking when the server already knows
// there is no session: the root layout decodes the auth cookie it is already
// reading and passes a `hasSessionCookie` hint to CartProvider.
//
// THE SECURITY PROPERTY THESE TESTS PIN is that the hint is a hint. It decides
// whether to spend a round trip, never who anyone is. A forged or expired
// cookie makes it true, the request goes out, and the route refuses it — the
// flag can cause a wasted request, never a granted one.
// ---------------------------------------------------------------------------

/**
 * Source with comments removed, via the shared scanner in test-support.
 *
 * These assertions scan file text, and this codebase explains a choice by
 * naming what it rejected: the note in layout.tsx says in so many words that it
 * uses `decodeAuthCookie` rather than `getAuthenticatedUser`, which would fail
 * the assertion that the layout does not verify. Reading past comments is what
 * lets the reasoning stay written next to the code it explains.
 */
const read = (path: string) =>
  assertNotGutted(path, stripComments(readFileSync(path, "utf8")));

const ROUTE = read("src/app/api/account/me/route.ts");
const LAYOUT = read("src/app/layout.tsx");
const CART = read("src/components/cart-context.tsx");
const CHECKOUT = read("src/app/checkout/page.tsx");

describe("the endpoint still refuses anonymous callers", () => {
  it("authenticates before it reads anything", () => {
    expect(ROUTE).toContain("getAuthenticatedUser()");
    expect(ROUTE).toMatch(/if \(!user \|\| detectRoleFromUser\(user\) !== "customer"\)/);
  });

  it("answers 401, not a 200 with an empty shape", () => {
    // Turning this into `{ success: true, ... }` for anonymous — the shape
    // /api/catalog/* routes use — would put an endpoint carrying email, name
    // and postal address on the same footing as public catalogue data, and
    // break the one invariant that makes /api/account/* legible in a log.
    expect(ROUTE).toMatch(/error: "Unauthorized" \}, \{ status: 401 \}/);
  });

  it("emits no account field before the auth check", () => {
    const beforeCheck = ROUTE.slice(0, ROUTE.indexOf("status: 401"));
    for (const field of ["user.email", "pointsBalance", "defaultAddress", "storeCredit"]) {
      expect(beforeCheck, `"${field}" is reachable before the 401`).not.toContain(field);
    }
  });
});

describe("every sibling account route keeps the same posture", () => {
  // The convention is what makes the 401 above correct rather than arbitrary.
  // ambassador-discount is the ONE documented exception and is excluded by
  // name: it carries no account data, only a percent, and it exists precisely
  // because an ambassador is a "partner" rather than a "customer".
  const routes = [
    "src/app/api/account/addresses/route.ts",
    "src/app/api/account/birthday/route.ts",
    "src/app/api/account/change-password/route.ts",
    "src/app/api/account/phone/route.ts",
    "src/app/api/account/preferences/route.ts",
    "src/app/api/account/reorder/route.ts",
    "src/app/api/account/wishlist/route.ts",
  ];

  it.each(routes)("%s refuses an anonymous caller with 401", (path) => {
    expect(read(path)).toContain("status: 401");
  });
});

describe("the hint is derived from the cookie, not trusted as identity", () => {
  it("the layout decodes the cookie locally and does not verify it there", () => {
    expect(LAYOUT).toContain("decodeAuthCookie(cookieStore.get(AUTH_COOKIE_NAME)?.value)");
    // Verifying in the root layout would put the auth backend on the render
    // path of every page on the site.
    expect(LAYOUT).not.toContain("getAuthenticatedUser");
  });

  it("reuses the cookieStore the layout already awaited, adding no second read", () => {
    // The saving is the whole justification for reading it here rather than
    // anywhere else: `cookies()` is awaited exactly once, for the offers bar,
    // and the consent cookie and this one are both taken off that same store.
    expect(LAYOUT.match(/cookies\(\)/g) ?? []).toHaveLength(1);
    expect(LAYOUT).toContain("cookieStore.get(AUTH_COOKIE_NAME)");
  });

  it("reports no session for an absent, empty or corrupt cookie", () => {
    for (const raw of [undefined, null, "", "   ", "v2.!!!not-base64!!!"]) {
      expect(decodeAuthCookie(raw), `input: ${String(raw)}`).toBeNull();
    }
  });

  it("reports a session for a real envelope and for a legacy bare JWT", () => {
    const envelope = encodeAuthCookie({ accessToken: "a.b.c", refreshToken: "r", rememberMe: true });
    expect(decodeAuthCookie(envelope)).not.toBeNull();
    // A cookie written before the envelope existed. Errs toward "ask", which
    // costs one refused request and never a missed pre-fill.
    expect(decodeAuthCookie("legacy.bare.jwt")).not.toBeNull();
  });

  it("an EXPIRED or FORGED cookie still produces a request the route refuses", () => {
    // The flag cannot distinguish these from a live session, and must not try:
    // that judgement belongs to getAuthenticatedUser(), which verifies the
    // signature. So both decode true, the client asks, and the endpoint says
    // 401 — precisely the behaviour that existed before this change.
    const forged = encodeAuthCookie({ accessToken: "not.a.real.jwt", refreshToken: "x", rememberMe: true });
    expect(decodeAuthCookie(forged)).not.toBeNull();
    expect(ROUTE).toContain("getAuthenticatedUser()");
  });

  it("names the cookie the auth system actually sets", () => {
    expect(AUTH_COOKIE_NAME).toBe("vl_session_token");
    expect(LAYOUT).toContain("AUTH_COOKIE_NAME");
  });
});

describe("the clients skip the call only when there is no cookie", () => {
  it("cart-context guards its account read on the hint", () => {
    expect(CART).toMatch(/if \(!hasSessionCookie\) return;/);
  });

  it("checkout guards its pre-fill on the same hint", () => {
    expect(CHECKOUT).toMatch(/if \(!hasSessionCookie\) return;/);
  });

  it("defaults to asking, so a provider without the prop is unchanged", () => {
    // A false default would silently strip personalization from every signed-in
    // customer the moment a caller forgot the prop.
    expect(CART).toMatch(/hasSessionCookie = true/);
  });

  it("leaves the anonymous-safe sibling call alone", () => {
    // /api/account/ambassador-discount answers 200 { percent: 0 } for anonymous
    // callers by design, so it produces no console entry and needs no guard.
    // Pinned so a future "tidy-up" does not gate it on a customer-session hint
    // — an ambassador is a partner, and this is the one account route whose
    // anonymous answer is a real answer.
    const ambassador = read("src/app/api/account/ambassador-discount/route.ts");
    expect(ambassador).not.toContain("status: 401");
    expect(ambassador).toMatch(/success: true, percent: 0/);
  });
});
