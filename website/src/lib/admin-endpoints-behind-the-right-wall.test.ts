import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import { middleware as runMiddleware } from "../../middleware";

// ---------------------------------------------------------------------------
// AN ADMIN IS AUTHENTICATED, AND THE WALL ONLY KNEW ONE COOKIE.
//
// Closing the default in access-policy.ts made every unlisted path require a
// CUSTOMER session — vl_session_token. The owner signs in at /vault and holds
// vl_admin_session, so unless they happened to be signed in as a customer in
// the same browser they had no customer cookie at all, and the wall refused
// them before any route's own guard ran.
//
// What that broke, on /admin/ads, all four fetched from the browser:
//
//   /api/ads/campaigns                        401 Sign in to continue
//   /api/ads/tracking-health                  401
//   /api/ads/tiktok-test-event                401
//   /api/ads/purchase-event/<id>?inspect=1    401
//
// Each panel renders its own error state, so the dashboard looked like a
// disconnected TikTok integration rather than a wall refusing the owner.
//
// The fix admits a VERIFIED admin session at the wall rather than adding the
// paths to the public list — those paths stay gated (access-policy.test.ts
// pins them), and purchase-event in particular must, because its admin check
// is inside the ?inspect=1 branch and exempting the path would reopen its
// anonymous bearer-token half.
// ---------------------------------------------------------------------------

const ORIGIN = "https://www.vantalabsresearch.com";
const API = join(process.cwd(), "src/app/api");

function routeFiles(dir: string, prefix = ""): Array<{ route: string; file: string }> {
  const found: Array<{ route: string; file: string }> = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...routeFiles(full, `${prefix}/${entry}`));
    else if (entry === "route.ts") found.push({ route: `/api${prefix}`, file: full });
  }
  return found;
}

/** Every API route that consults the admin session cookie at all. */
const ADMIN_AUTHENTICATED = routeFiles(API)
  .filter(({ file }) => /verifyAdminSessionFromCookie\s*\(/.test(readFileSync(file, "utf8")))
  .map(({ route }) => route.replace(/\[\[?\.{3}?([^\]]+)\]?\]/g, "sample"));

/**
 * A Supabase that answers the admin-session lookups and nothing else.
 *
 * middleware verifies the cookie by hashing it, finding an unexpired row in
 * admin_sessions and confirming the admin is still active. Both reads are
 * stubbed here so the test exercises the WALL rather than the database.
 */
function stubSupabase(options: { validAdmin: boolean }) {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://stub.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/rest/v1/admin_sessions")) {
      return new Response(JSON.stringify(options.validAdmin ? [{ id: "s1", username: "owner" }] : []), { status: 200 });
    }
    if (url.includes("/rest/v1/admin_credentials")) {
      return new Response(JSON.stringify([{ is_active: options.validAdmin }]), { status: 200 });
    }
    if (url.includes("/rest/v1/admin_audit_logs")) {
      return new Response(JSON.stringify([]), { status: 200 }); // maintenance mode off
    }
    // Any customer-session verification must FAIL: the whole point is an admin
    // who holds no customer cookie.
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }));
}

const request = (path: string, cookie?: string) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "GET", headers: cookie ? { cookie } : undefined });

describe("the wall admits a verified admin session", () => {
  beforeEach(() => {
    // A token this run has to itself, so middleware's 30s session cache cannot
    // carry an answer between cases.
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("finds admin-authenticated routes at all, so this cannot pass vacuously", () => {
    expect(ADMIN_AUTHENTICATED.length).toBeGreaterThan(5);
    expect(ADMIN_AUTHENTICATED).toContain("/api/ads/campaigns");
    expect(ADMIN_AUTHENTICATED).toContain("/api/ads/tracking-health");
  });

  it.each([
    "/api/ads/campaigns",
    "/api/ads/tracking-health",
    "/api/ads/tiktok-test-event",
    "/api/ads/purchase-event/order-abc",
  ])("%s reaches its handler for an admin with no customer session", async (path) => {
    stubSupabase({ validAdmin: true });
    const response = await runMiddleware(request(path, `vl_admin_session=admin-token-${path}`));
    expect(response.status, `${path} must not be refused by the customer wall`).not.toBe(401);
    expect(response.headers.get("location")).toBeNull();
  });

  it("still refuses the same paths with no cookie at all", async () => {
    stubSupabase({ validAdmin: false });
    for (const path of ["/api/ads/campaigns", "/api/ads/tracking-health", "/api/ads/purchase-event/order-abc"]) {
      const response = await runMiddleware(request(path));
      expect(response.status, `${path} must stay gated for an anonymous caller`).toBe(401);
    }
  });

  it("refuses a forged admin cookie the session table does not recognise", async () => {
    stubSupabase({ validAdmin: false });
    const response = await runMiddleware(request("/api/ads/campaigns", "vl_admin_session=forged-not-in-table"));
    expect(response.status).toBe(401);
  });

  it("refuses a real session belonging to a DEACTIVATED admin", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://stub.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/rest/v1/admin_sessions")) return new Response(JSON.stringify([{ id: "s1", username: "owner" }]), { status: 200 });
      if (url.includes("/rest/v1/admin_credentials")) return new Response(JSON.stringify([{ is_active: false }]), { status: 200 });
      if (url.includes("/rest/v1/admin_audit_logs")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }));

    const response = await runMiddleware(request("/api/ads/campaigns", "vl_admin_session=deactivated-admin"));
    expect(response.status).toBe(401);
  });

  it("does NOT let an admin session stand in for a customer on /account", async () => {
    stubSupabase({ validAdmin: true });
    // An admin opening a customer's own page is asking for a customer session,
    // and must still be sent to the customer sign-in.
    const response = await runMiddleware(request("/account/orders", "vl_admin_session=admin-token-account"));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "", ORIGIN).pathname).toBe("/account/login");
  });

  it("still refuses the catalog to an anonymous visitor", async () => {
    stubSupabase({ validAdmin: false });
    const response = await runMiddleware(request("/products/glp-1"));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "", ORIGIN).pathname).toBe("/account/login");
  });
});

describe("per-requester responses are never shared-cacheable", () => {
  it("marks the self-authenticating surfaces private, which requiresAccount alone did not", async () => {
    const { isPerRequesterResponse } = await import("@/lib/access-policy");
    for (const path of ["/api/admin/orders", "/api/partner/apply", "/admin/ads", "/vault", "/partner/dashboard"]) {
      expect(isPerRequesterResponse(path), `${path} depends on who asked`).toBe(true);
    }
    // and the genuinely anonymous surface stays cacheable
    for (const path of ["/legal/privacy", "/contact", "/_next/static/chunk.js", "/images/hero.jpg"]) {
      expect(isPerRequesterResponse(path), `${path} is the same for everyone`).toBe(false);
    }
  });
});
