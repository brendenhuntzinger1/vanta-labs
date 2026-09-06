import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { middleware } from "../../middleware";
import { encodeAuthCookie } from "@/lib/auth-cookie";

// ---------------------------------------------------------------------------
// A GUEST OPENING AN ACCOUNT PAGE IS SENT TO SIGN IN — AND THEN BACK.
//
// Every account page guarded itself with a bare redirect("/account/login"),
// so a customer who opened /account/orders from an email signed in and
// landed on the home page. The middleware now attaches ?next= for a request
// that carries no session cookie at all; the login form already honours it.
// ---------------------------------------------------------------------------

const ORIGIN = "https://www.vantalabsresearch.com";

async function guestGet(path: string) {
  return middleware(new NextRequest(`${ORIGIN}${path}`, { method: "GET" }));
}

describe("a signed-out visitor on an account page", () => {
  it("is redirected to sign in with the page they asked for as next", async () => {
    const response = await guestGet("/account/orders?tab=recent");
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/account/login");
    expect(location.searchParams.get("next")).toBe("/account/orders?tab=recent");
  });

  it("covers the dashboard root too", async () => {
    const location = new URL((await guestGet("/account")).headers.get("location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/account/login");
    expect(location.searchParams.get("next")).toBe("/account");
  });

  it.each(["/account/login", "/account/forgot-password", "/account/reset-password"])("leaves %s reachable", async (path) => {
    const response = await guestGet(path);
    expect(response.status).not.toBe(307);
  });

  // THIS USED TO ASSERT THAT ANY COOKIE WAS ENOUGH, AND THAT WAS THE BUG.
  //
  // It sent `vl_session_token=v2.abc` — a value with no token in it at all —
  // and asserted the visitor was NOT diverted, on the reasoning that "the page
  // decides". The page did decide, for /account. Nothing decided for the five
  // other surfaces that had no guard of their own, and a single forged header
  // put the live promotion and its coupon code into the home page's HTML. The
  // wall verifies the token now, so the contract this pins has flipped: a
  // cookie that cannot be verified is a signed-out visitor.
  it("diverts a cookie that carries no usable token", async () => {
    const response = await middleware(
      new NextRequest(`${ORIGIN}/account/orders`, { method: "GET", headers: { cookie: "vl_session_token=v2.abc" } }),
    );
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "", ORIGIN).pathname).toBe("/account/login");
  });

  it("does not divert a session the auth backend recognises", async () => {
    // The other half of the same contract, and the one that would show up as a
    // mass logout rather than a leak. Stubbed here rather than mocked globally
    // — see vitest.setup.ts — because only a running GoTrue can tell a real
    // signature from a forged one, and this suite has none.
    const restore = { ...process.env };
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://auth.test.invalid";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";

    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    // Unexpired, so nothing tries to refresh it, and unique to this test so the
    // module-level verification cache cannot answer from another one.
    const accessToken = [
      b64({ alg: "HS256", typ: "JWT" }),
      b64({ sub: "11111111-1111-1111-1111-111111111111", exp: Math.floor(Date.now() / 1000) + 3600 }),
      `signature-${Date.now()}`,
    ].join(".");

    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("/auth/v1/user")) {
        return new Response(JSON.stringify({ id: "11111111-1111-1111-1111-111111111111" }), { status: 200 });
      }
      // The maintenance-mode lookup that runs after the gate.
      return new Response("[]", { status: 200 });
    }));

    try {
      const cookie = `vl_session_token=${encodeAuthCookie({ accessToken, refreshToken: "r", rememberMe: true })}`;
      const response = await middleware(
        new NextRequest(`${ORIGIN}/account/orders`, { method: "GET", headers: { cookie } }),
      );
      expect(response.status).not.toBe(307);
      // And it asked, rather than taking the cookie's word for it.
      expect(seen.some((url) => url.includes("/auth/v1/user"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      process.env = restore;
    }
  });

  // THIS USED TO ASSERT THE OPPOSITE, AND THE CATALOG GATE IS WHY.
  //
  // The account gate's contract was "divert /account and nothing else", so this
  // test proved it left the storefront alone by checking that /products was not
  // a redirect for a guest. /products now requires an account in its own right
  // (GATED_PREFIXES in middleware.ts), so a guest asking for it IS redirected —
  // by a different rule, to the same login page, for a different reason.
  //
  // What this test still needs to prove is that the ACCOUNT gate has not
  // widened. A public page is the honest probe for that now.
  it("leaves the paths that must stay reachable alone", async () => {
    // This used to probe "/" and "/research", which were public. They are not
    // any more — the default is closed and the owner accepted that the home
    // page and research library leave Google's index. So the honest probe for
    // "the account gate has not widened" is a path that must work for someone
    // with no account at all, and a legal policy is the clearest case: it has
    // to be readable to be agreed to.
    expect((await guestGet("/legal/privacy")).status).not.toBe(307);
    expect((await guestGet("/contact")).status).not.toBe(307);
  });

  it("sends a guest asking for the catalog to sign in, carrying the path back", async () => {
    const response = await guestGet("/products");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/account/login");
    expect(response.headers.get("location")).toContain("next=%2Fproducts");
  });
});
