import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACCESS_TOKEN_REFRESH_SKEW_SECONDS,
  AUTH_COOKIE_NAME,
  AUTH_COOKIE_REMEMBER_MAX_AGE_SECONDS,
  accessTokenExpiresAt,
  accessTokenNeedsRefresh,
  authCookieOptions,
  decodeAuthCookie,
  encodeAuthCookie,
} from "@/lib/auth-cookie";

// ---------------------------------------------------------------------------
// "KEEP ME SIGNED IN ON THIS DEVICE" LASTED ONE HOUR.
//
// The cookie was set with maxAge 30 days and its entire value was a raw
// Supabase access JWT, which expires in an hour. No refresh token was stored
// anywhere and nothing pushed the browser client's rotated token back into it,
// so getUser() started failing the moment the JWT lapsed and the customer was
// silently signed out mid-session — having explicitly asked not to be.
//
// It also kept the shared-browser hazard on the login page permanently live:
// our cookie expired hourly while supabase-js kept a self-refreshing session in
// localStorage for weeks, so "signed out here, still signed in there" was the
// ordinary state of a returning customer.
// ---------------------------------------------------------------------------

/** A JWT-shaped string with a real `exp`. Only the payload is ever read. */
function jwtExpiringAt(exp: number): string {
  const b64 = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ sub: "user", exp })}.signature`;
}

const NOW = 1_800_000_000;

describe("the cookie carries what it needs to renew itself", () => {
  it("round-trips the token pair", () => {
    const encoded = encodeAuthCookie({ accessToken: "a", refreshToken: "r", rememberMe: true });
    expect(decodeAuthCookie(encoded)).toEqual({ accessToken: "a", refreshToken: "r", rememberMe: true });
  });

  it("remembers whether this was a remembered session", () => {
    // A browser sends back only `name=value`, never the attributes — so if this
    // is not inside the value, a refresh cannot tell a 30-day cookie from a
    // browser-close one and must guess. Guessing either way is wrong: it either
    // promotes a session cookie to 30 days or demotes a remembered device.
    const session = encodeAuthCookie({ accessToken: "a", refreshToken: "r", rememberMe: false });
    expect(decodeAuthCookie(session)?.rememberMe).toBe(false);
  });

  it("keeps a cookie written before this change working", () => {
    // Nobody signed in at deploy time may be logged out by the deploy.
    const legacy = decodeAuthCookie("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.sig");
    expect(legacy?.accessToken).toBe("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.sig");
    expect(legacy?.refreshToken).toBeNull();
  });

  it("treats an absent, empty or corrupt cookie as signed out, never as a crash", () => {
    expect(decodeAuthCookie(null)).toBeNull();
    expect(decodeAuthCookie("")).toBeNull();
    expect(decodeAuthCookie("   ")).toBeNull();
    expect(decodeAuthCookie("v2.@@@not-base64@@@")).toBeNull();
    expect(decodeAuthCookie("v2." + Buffer.from('{"r":"only"}').toString("base64url"))).toBeNull();
  });

  it("stays a bare token when there is no refresh token to carry", () => {
    // A caller that supplies none behaves exactly as before rather than
    // silently changing the cookie's shape.
    expect(encodeAuthCookie({ accessToken: "a", refreshToken: null, rememberMe: true })).toBe("a");
  });
});

describe("when to spend a network call refreshing", () => {
  it("reads the expiry out of the token locally", () => {
    expect(accessTokenExpiresAt(jwtExpiringAt(NOW))).toBe(NOW);
  });

  it("says no while the token is still good", () => {
    expect(accessTokenNeedsRefresh(jwtExpiringAt(NOW + 3600), NOW)).toBe(false);
  });

  it("says yes once it has expired", () => {
    expect(accessTokenNeedsRefresh(jwtExpiringAt(NOW - 1), NOW)).toBe(true);
  });

  it("refreshes slightly early, so a token cannot expire mid-render", () => {
    const justInsideSkew = jwtExpiringAt(NOW + ACCESS_TOKEN_REFRESH_SKEW_SECONDS - 1);
    expect(accessTokenNeedsRefresh(justInsideSkew, NOW)).toBe(true);
  });

  it("never refreshes on a token whose expiry cannot be read", () => {
    // Otherwise an unparseable token refreshes on every single request forever.
    expect(accessTokenNeedsRefresh("not-a-jwt", NOW)).toBe(false);
    expect(accessTokenNeedsRefresh("a.b.c", NOW)).toBe(false);
    expect(accessTokenExpiresAt("a.b")).toBeNull();
  });
});

describe("cookie attributes", () => {
  it("keeps a remembered session for 30 days", () => {
    expect(authCookieOptions(true).maxAge).toBe(AUTH_COOKIE_REMEMBER_MAX_AGE_SECONDS);
    expect(AUTH_COOKIE_REMEMBER_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 30);
  });

  it("makes an unremembered session die with the browser", () => {
    expect(authCookieOptions(false)).not.toHaveProperty("maxAge");
  });

  it("is httpOnly and SameSite=Lax, which is what actually protects it", () => {
    // The base64url encoding is packaging, not protection. These are the
    // attributes that keep the cookie away from script and cross-site requests.
    const options = authCookieOptions(true);
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
  });
});

// ---------------------------------------------------------------------------
// The rotation itself needs a live GoTrue; what regresses is the wiring.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const MIDDLEWARE = read("middleware.ts");
const SESSION_ROUTE = read("src/app/api/auth/session/route.ts");

describe("the rotation is actually wired up", () => {
  it("middleware rotates the pair", () => {
    expect(MIDDLEWARE).toContain("rotateSessionCookie");
    expect(MIDDLEWARE).toContain("grant_type=refresh_token");
  });

  it("attaches the new cookie to every response it returns", () => {
    // Seven exits from middleware(). A rotation attached to only some of them
    // would renew the session on some pages and not others.
    // Everything AFTER the finish() helper, which legitimately ends in the
    // applySecurityHeaders call every exit used to make for itself.
    const body = MIDDLEWARE.slice(MIDDLEWARE.indexOf("const finish = (response: NextResponse)"));
    const afterHelper = body.slice(body.indexOf("};") + 2);
    expect(afterHelper).not.toContain("return applySecurityHeaders(");
    expect((body.match(/return finish\(/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });

  it("does no work at all for a static asset", () => {
    expect(MIDDLEWARE).toContain("isStaticAsset(pathname) ? null : await rotateSessionCookie(request)");
  });

  it("leaves a rejected refresh token alone rather than clearing the cookie", () => {
    // Clearing here would sign a customer out on a transient 5xx.
    const fn = MIDDLEWARE.slice(
      MIDDLEWARE.indexOf("async function rotateSessionCookie("),
      MIDDLEWARE.indexOf("export async function middleware("),
    );
    expect(fn).not.toContain("buildExpiredAuthCookie");
    expect(fn).not.toContain("delete(");
  });

  it("the session route stores the refresh token it is given", () => {
    expect(SESSION_ROUTE).toContain("body?.refreshToken");
    expect(SESSION_ROUTE).toContain("buildAuthCookieValue(accessToken, rememberMe, refreshToken)");
  });

  it("every client that establishes a session sends one", () => {
    for (const path of [
      "src/components/account-auth-form.tsx",
      "src/components/account-reset-password-form.tsx",
      "src/components/partner-program-landing.tsx",
    ]) {
      const src = read(path);
      const posts = (src.match(/JSON\.stringify\(\{ accessToken/g) ?? []).length;
      const withRefresh = (src.match(/JSON\.stringify\(\{ accessToken, refreshToken/g) ?? []).length;
      expect(withRefresh, `${path} posts a session without a refresh token`).toBe(posts);
    }
  });

  it("uses one cookie name everywhere", () => {
    expect(AUTH_COOKIE_NAME).toBe("vl_session_token");
    expect(MIDDLEWARE).toContain("AUTH_COOKIE_NAME");
  });
});
