import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// THE DENY-BY-DEFAULT WALL HAS TWO BLIND SPOTS, AND THIS TEST WATCHES THEM.
//
// middleware.ts closes the default: any path not named in access-policy.ts
// needs a verified customer session. But two prefixes are named PUBLIC there on
// purpose — "surfaces with their OWN authentication boundary":
//
//     "/admin", "/api/admin"      the staff console (its own session cookie)
//     "/api/partner"              the ambassador portal (customer session)
//
// The wall waves every request under those prefixes straight through. Nothing
// in the middleware layer checks them, by design — a customer gate in front of
// an admin login would lock the owner out of their own store. So the ONLY thing
// standing between an anonymous request and these handlers is the auth check
// each handler runs for ITSELF. A new route dropped in here with no such check
// is wide open, and access-policy.test.ts would still pass, because at the wall
// layer these prefixes ARE public and that is correct.
//
// This is exactly the failure deny-by-default was built to prevent — a route
// arriving unprotected because someone forgot — reproduced in the one place the
// wall cannot see. So this test reads every handler under those two prefixes
// and fails if one neither authenticates nor is on the short, justified list of
// endpoints that CANNOT (the ones that create a session, and the one aggregate
// number the recruitment page publishes on purpose).
//
// It is a tripwire, not a proof: it asserts the auth call is PRESENT in the
// source, not that it can never be bypassed. A handler that names no check at
// all is the mistake this catches, and it is the mistake that actually happens.
// ---------------------------------------------------------------------------

const API_ROOT = join(process.cwd(), "src/app/api");

function routeFilesUnder(prefix: string): string[] {
  const root = join(API_ROOT, prefix);
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith("route.ts"))
    .map((f) => `${prefix}/${f}`.replace(/\\/g, "/"));
}

const ADMIN_AUTH = /verifyAdminSessionFrom(Request|Cookie)/;
const PARTNER_AUTH = /getAuthenticatedUser\(|auth\.getUser\(/;

const INTENTIONALLY_UNAUTHENTICATED = new Map<string, string>([
  ["admin/auth/login/route.ts", "creates the admin session; it cannot require one to exist"],
  ["admin/auth/logout/route.ts", "clears the admin session; a dead cookie must still be clearable"],
  [
    "partner/program-stats/route.ts",
    "publishes only aggregate recruitment numbers on the public /partner page; holds no catalogue, customer or order data",
  ],
]);

const read = (relFromApi: string) => readFileSync(join(API_ROOT, relFromApi), "utf8");

describe("every /api/admin handler authenticates itself", () => {
  const files = routeFilesUnder("admin");

  it("finds the admin routes at all (guards against a broken glob)", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it.each(files)("%s calls verifyAdminSessionFromRequest/Cookie, or is a named exception", (rel) => {
    if (INTENTIONALLY_UNAUTHENTICATED.has(rel)) {
      expect(INTENTIONALLY_UNAUTHENTICATED.get(rel)).toBeTruthy();
      return;
    }
    expect(ADMIN_AUTH.test(read(rel)), `${rel} names no admin auth check`).toBe(true);
  });
});

describe("every /api/partner handler authenticates itself", () => {
  const files = routeFilesUnder("partner");

  it("finds the partner routes at all", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it.each(files)("%s verifies the customer, or is a named exception", (rel) => {
    if (INTENTIONALLY_UNAUTHENTICATED.has(rel)) {
      expect(INTENTIONALLY_UNAUTHENTICATED.get(rel)).toBeTruthy();
      return;
    }
    expect(PARTNER_AUTH.test(read(rel)), `${rel} names no customer auth check`).toBe(true);
  });
});

describe("the unauthenticated exception list stays short and deliberate", () => {
  it("holds only the endpoints that genuinely cannot authenticate", () => {
    expect(INTENTIONALLY_UNAUTHENTICATED.size).toBeLessThanOrEqual(4);
  });
});
