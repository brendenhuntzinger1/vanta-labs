import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { middleware } from "../../middleware";

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

  it("does not divert a request that carries a session cookie — the page decides", async () => {
    const response = await middleware(
      new NextRequest(`${ORIGIN}/account/orders`, { method: "GET", headers: { cookie: "vl_session_token=v2.abc" } }),
    );
    expect(response.status).not.toBe(307);
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
  it("does not touch the public storefront", async () => {
    expect((await guestGet("/research")).status).not.toBe(307);
    expect((await guestGet("/")).status).not.toBe(307);
  });

  it("sends a guest asking for the catalog to sign in, carrying the path back", async () => {
    const response = await guestGet("/products");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/account/login");
    expect(response.headers.get("location")).toContain("next=%2Fproducts");
  });
});
