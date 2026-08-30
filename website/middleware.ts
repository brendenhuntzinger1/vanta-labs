import { NextRequest, NextResponse } from "next/server";

import {
  AUTH_COOKIE_NAME,
  accessTokenNeedsRefresh,
  authCookieOptions,
  decodeAuthCookie,
  encodeAuthCookie,
} from "@/lib/auth-cookie";

const ADMIN_SESSION_COOKIE = "vl_admin_session";
const MAINTENANCE_CACHE_TTL_MS = 15_000;
const SESSION_CACHE_TTL_MS = 30_000;

let maintenanceCacheValue = false;
let maintenanceCacheExpiresAt = 0;

const sessionCache = new Map<string, { value: boolean; expiresAt: number }>();

function applySecurityHeaders(response: NextResponse) {
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  // HSTS: force HTTPS for two years incl. subdomains. Safe for an HTTPS-only
  // storefront and expected for anything handling payment/auth.
  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  // Content-Security-Policy — deliberately the SAFE subset that hardens the
  // real attack surface WITHOUT a default-src/script-src/style-src allowlist.
  // Next.js injects inline hydration scripts and styled-jsx inline styles with
  // no nonce here, so a default-src/script-src restriction would break
  // hydration site-wide (those need a nonce-based rollout, tracked for
  // post-launch). We intentionally OMIT default-src so scripts/styles/images
  // stay unrestricted, while still closing: plugin/object injection
  // (object-src), <base>-tag hijacking (base-uri), clickjacking
  // (frame-ancestors, duplicating X-Frame-Options), off-site form posts
  // (form-action), and mixed content (upgrade-insecure-requests). This never
  // breaks first-party pages.
  response.headers.set(
    "Content-Security-Policy",
    [
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "upgrade-insecure-requests",
    ].join("; "),
  );
  return response;
}

function isStateChangingMethod(method: string) {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function isStaticAsset(pathname: string) {
  if (pathname.startsWith("/_next")) {
    return true;
  }

  if (pathname.startsWith("/images") || pathname.startsWith("/fonts")) {
    return true;
  }

  if (pathname === "/favicon.ico" || pathname === "/robots.txt" || pathname === "/sitemap.xml") {
    return true;
  }

  return /\.[a-z0-9]+$/i.test(pathname);
}

function pathBypassesMaintenance(pathname: string) {
  return (
    pathname === "/maintenance"
    // Domain-verification files (Apple Pay's
    // apple-developer-merchantid-domain-association, and anything else served
    // under /.well-known). isStaticAsset() does NOT cover these: its
    // trailing-extension test never matches a path ending in "-association", so
    // with maintenance mode on they were rewritten to /maintenance and Apple Pay
    // silently died sitewide the next time the domain was re-verified.
    || pathname.startsWith("/.well-known/")
    || pathname.startsWith("/vault")
    || pathname.startsWith("/admin")
    || pathname.startsWith("/api/admin")
    || pathname.startsWith("/api/webhooks")
    || pathname.startsWith("/api/analytics/track")
    // K-14. Maintenance mode is a shop-front notice, not a kill switch for the
    // machinery behind it. Without these, turning it on:
    //
    //   /api/cron        503s the ENTIRE sweep — all thirteen jobs, including
    //                    reservation expiry, payment reconciliation and the
    //                    email retry queue. Authenticated by CRON_SECRET, not a
    //                    session, so nothing human reaches it anyway.
    //   /api/unsubscribe breaks the one-click unsubscribe link in marketing mail
    //                    that has ALREADY been delivered. That link has to work
    //                    whatever the storefront is doing.
    //   /api/veyra       is a processor callback, exactly like /api/webhooks
    //                    beside it. Dropping it loses membership events.
    //   /api/coa         serves published certificates — a compliance document,
    //                    not a shopping page.
    //   /api/health      is how anyone finds out the site is up at all.
    || pathname.startsWith("/api/cron")
    || pathname.startsWith("/api/unsubscribe")
    || pathname.startsWith("/api/veyra")
    || pathname.startsWith("/api/coa")
    || pathname.startsWith("/api/health")
    // Password recovery, for the same reason as /api/unsubscribe above: these
    // are promises made in an email that has ALREADY been delivered. A customer
    // who clicks a reset link during a maintenance window is the one person who
    // most needs the page to answer, and rewriting them to /maintenance burns
    // the one-time token in the link for nothing. Reaching these two pages
    // grants no access to the storefront the window is closing.
    || pathname === "/account/forgot-password"
    || pathname === "/account/reset-password"
    || pathname.startsWith("/api/auth/password-reset")
    || isStaticAsset(pathname)
  );
}

function isSameOriginRequest(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) {
    return false;
  }

  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const expected = `${proto}://${host}`;
  return origin === expected;
}

function getSupabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) {
    return null;
  }

  return { url, serviceRole };
}

async function sha256Hex(value: string) {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  const bytes = Array.from(new Uint8Array(hash));
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchMaintenanceMode() {
  const config = getSupabaseConfig();
  if (!config) {
    return false;
  }

  const query = new URLSearchParams({
    select: "metadata,created_at",
    action: "eq.admin_control_upsert",
    target_table: "eq.settings",
    target_id: "eq.maintenance_mode",
    order: "created_at.desc",
    limit: "1",
  });

  try {
    const response = await fetch(`${config.url}/rest/v1/admin_audit_logs?${query.toString()}`, {
      headers: {
        apikey: config.serviceRole,
        Authorization: `Bearer ${config.serviceRole}`,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return false;
    }

    const rows = (await response.json()) as Array<{ metadata?: { value?: unknown } }>;
    const row = rows[0];
    return row?.metadata?.value === true;
  } catch {
    // FAIL OPEN. This runs in middleware on EVERY request; an unhandled throw
    // here (Supabase network blip, DNS, timeout) would 500 the entire site —
    // every page and API route. Maintenance mode is the exceptional state, so
    // default to "not in maintenance" (site stays up) when the check fails.
    return false;
  }
}

async function isMaintenanceEnabled() {
  const now = Date.now();
  if (maintenanceCacheExpiresAt > now) {
    return maintenanceCacheValue;
  }

  const enabled = await fetchMaintenanceMode();
  maintenanceCacheValue = enabled;
  maintenanceCacheExpiresAt = now + MAINTENANCE_CACHE_TTL_MS;
  return enabled;
}

async function isValidAdminSessionToken(token: string) {
  const cached = sessionCache.get(token);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const config = getSupabaseConfig();
  if (!config) {
    return false;
  }

  const tokenHash = await sha256Hex(token);
  const query = new URLSearchParams({
    select: "id,username",
    token_hash: `eq.${tokenHash}`,
    expires_at: `gt.${new Date().toISOString()}`,
    limit: "1",
  });

  const authHeaders = {
    apikey: config.serviceRole,
    Authorization: `Bearer ${config.serviceRole}`,
  };

  try {
    const response = await fetch(`${config.url}/rest/v1/admin_sessions?${query.toString()}`, {
      headers: authHeaders,
      cache: "no-store",
    });

    if (!response.ok) {
      sessionCache.set(token, { value: false, expiresAt: now + SESSION_CACHE_TTL_MS });
      return false;
    }

    const rows = (await response.json()) as Array<{ id: string; username?: string }>;
    const username = rows[0]?.username;
    let valid = rows.length > 0 && Boolean(username);

    // Mirror verifyAdminSessionToken: a deactivated admin must not keep the
    // maintenance-page bypass just because their session cookie is unexpired.
    if (valid && username) {
      const credQuery = new URLSearchParams({
        select: "is_active",
        username: `eq.${username}`,
        limit: "1",
      });
      const credResponse = await fetch(`${config.url}/rest/v1/admin_credentials?${credQuery.toString()}`, {
        headers: authHeaders,
        cache: "no-store",
      });
      if (!credResponse.ok) {
        valid = false;
      } else {
        const credRows = (await credResponse.json()) as Array<{ is_active?: boolean }>;
        valid = credRows.length > 0 && credRows[0]?.is_active !== false;
      }
    }

    sessionCache.set(token, { value: valid, expiresAt: now + SESSION_CACHE_TTL_MS });
    return valid;
  } catch {
    // Fail closed for admin-session validation (deny), but never throw — a
    // thrown fetch in middleware 500s the whole request. Cache the negative
    // briefly so a Supabase blip doesn't hammer it on every request.
    sessionCache.set(token, { value: false, expiresAt: now + SESSION_CACHE_TTL_MS });
    return false;
  }
}

async function hasValidAdminSession(request: NextRequest) {
  const token = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) {
    return false;
  }

  return isValidAdminSessionToken(token);
}

// A MEDIA FILE IS NOT A LANDING PAGE.
//
// Opening a .mp4 as a page gives you the browser's bare media viewer: the clip
// alone on a blank white background, no site, no header, no age gate. That is
// exactly what was reported from TikTok and the ad platforms — and only from
// there, because that is where the destination link is configured. A link that
// points at the hero file, or an older redirect that still resolves to it,
// produces this every time while typing the domain into Safari looks perfect.
//
// This makes the destination survive being wrong. A top-level navigation to a
// media file is sent to the home page instead, so an ad click lands on the
// storefront whatever the campaign URL says.
//
// It does NOT interfere with the hero playing. A <video> fetches its source
// with Sec-Fetch-Dest: video (or audio/empty for a range request), never
// "document" — only an address-bar-style navigation is redirected. The header
// is sent by every browser that matters; where it is absent nothing changes,
// so the media still loads.
const MEDIA_EXTENSIONS = /\.(mp4|webm|mov|m4v|ogv|avi|mkv|mp3|wav|m4a)$/i;

function isTopLevelNavigation(request: NextRequest) {
  return (
    request.method === "GET" &&
    request.headers.get("sec-fetch-dest") === "document" &&
    // A range request is a media player fetching bytes, never a page load.
    !request.headers.get("range")
  );
}

// ---------------------------------------------------------------------------
// KEEPING "KEEP ME SIGNED IN" TRUE.
//
// The session cookie lives 30 days; the access JWT inside it lives an hour.
// Nothing renewed it, so the checkbox delivered sixty minutes and then signed
// the customer out mid-session. This is where the pair is rotated — middleware
// is the only place that sees every request AND can write a cookie.
//
// The common case costs nothing: expiry is read out of the JWT locally, so a
// live token means no network call and no work at all. Only an expired one
// spends a round trip, and only on a real page or API request — never on a
// static asset.
//
// `exp` is read WITHOUT verifying the signature, which is safe because it is
// used for one decision: whether to try refreshing. A forged `exp` buys nothing
// — GoTrue still has to accept the refresh token, and every authentication
// decision downstream still goes through getUser().
// ---------------------------------------------------------------------------
async function rotateSessionCookie(
  request: NextRequest,
): Promise<{ name: string; value: string; options: ReturnType<typeof authCookieOptions> } | null> {
  const tokens = decodeAuthCookie(request.cookies.get(AUTH_COOKIE_NAME)?.value);
  if (!tokens?.refreshToken) {
    // No cookie, or one written before the envelope existed. A legacy cookie
    // keeps its old behaviour until the customer's next sign-in rewrites it,
    // which is deliberate: nobody signed in at deploy time gets logged out.
    return null;
  }

  if (!accessTokenNeedsRefresh(tokens.accessToken, Math.floor(Date.now() / 1000))) {
    return null;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return null;
  }

  try {
    // Called over plain fetch rather than through supabase-js: this is the Edge
    // runtime on every request in the app, and the whole client is a large
    // dependency to pull in for one endpoint.
    const response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: supabaseKey },
      body: JSON.stringify({ refresh_token: tokens.refreshToken }),
    });

    if (!response.ok) {
      // A refresh token that GoTrue rejects is spent or revoked — a signed-out
      // customer. The stale cookie is left alone rather than cleared: clearing
      // it here would log someone out on a transient 5xx, and getAuthenticatedUser
      // already treats an unusable token as signed out.
      return null;
    }

    const body = await response.json();
    const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
    const refreshToken = typeof body?.refresh_token === "string" ? body.refresh_token : "";
    if (!accessToken || !refreshToken) {
      return null;
    }

    return {
      name: AUTH_COOKIE_NAME,
      value: encodeAuthCookie({ accessToken, refreshToken, rememberMe: tokens.rememberMe }),
      options: authCookieOptions(tokens.rememberMe),
    };
  } catch {
    // Never let an auth-backend blip turn into a failed page load.
    return null;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Rotated once per request, then attached to whichever response is returned
  // below. Skipped entirely for static assets, which never need a session.
  const refreshedCookie = isStaticAsset(pathname) ? null : await rotateSessionCookie(request);
  const finish = (response: NextResponse) => {
    if (refreshedCookie) {
      response.cookies.set(refreshedCookie.name, refreshedCookie.value, refreshedCookie.options);
    }
    return applySecurityHeaders(response);
  };

  if (MEDIA_EXTENSIONS.test(pathname) && isTopLevelNavigation(request)) {
    const home = request.nextUrl.clone();
    home.pathname = "/";
    home.search = "";
    // 307, not 308: this is a routing correction, not a permanent statement
    // about the asset's address, and it must not be cached by intermediaries
    // in a way that would follow the file itself around.
    return finish(NextResponse.redirect(home, 307));
  }

  // CSRF defense-in-depth: reject cross-site state-changing requests to the
  // cookie-authenticated app APIs. Webhooks (/api/webhooks, HMAC-signed) and
  // cron (/api/cron, bearer-secret) live under other prefixes and are NOT
  // same-origin, so they're intentionally excluded. SameSite=Lax already
  // mitigates classic CSRF; this is a second, explicit layer.
  // /api/auth is here because it both SETS the session cookie and now sends
  // password-reset mail. SameSite=Lax already stops a cross-site POST's
  // Set-Cookie from sticking, so this is the second layer rather than the only
  // one -- but it was the single auth endpoint outside the list, which is not a
  // distinction any auth endpoint should have.
  const CSRF_PROTECTED_PREFIXES = ["/api/admin", "/api/account", "/api/auth", "/api/membership", "/api/partner"];
  if (
    isStateChangingMethod(request.method) &&
    CSRF_PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix)) &&
    !isSameOriginRequest(request)
  ) {
    return finish(
      NextResponse.json(
        { success: false, error: "Invalid request origin" },
        { status: 403 },
      ),
    );
  }

  if (pathBypassesMaintenance(pathname)) {
    return finish(NextResponse.next());
  }

  const maintenanceEnabled = await isMaintenanceEnabled();
  if (!maintenanceEnabled) {
    return finish(NextResponse.next());
  }

  const isAdmin = await hasValidAdminSession(request);
  if (isAdmin) {
    return finish(NextResponse.next());
  }

  if (pathname.startsWith("/api/")) {
    return finish(
      NextResponse.json(
        { success: false, error: "Maintenance mode enabled" },
        { status: 503 },
      ),
    );
  }

  const rewriteUrl = request.nextUrl.clone();
  rewriteUrl.pathname = "/maintenance";
  rewriteUrl.search = "";
  return finish(NextResponse.rewrite(rewriteUrl));
}

export const config = {
  matcher: "/:path*",
};
