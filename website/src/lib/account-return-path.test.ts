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

  it("does not touch the storefront", async () => {
    expect((await guestGet("/products")).status).not.toBe(307);
  });
});
