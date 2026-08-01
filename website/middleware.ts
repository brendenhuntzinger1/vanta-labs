import { NextRequest, NextResponse } from "next/server";

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
    || pathname.startsWith("/vault")
    || pathname.startsWith("/admin")
    || pathname.startsWith("/api/admin")
    || pathname.startsWith("/api/webhooks")
    || pathname.startsWith("/api/analytics/track")
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

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // CSRF defense-in-depth: reject cross-site state-changing requests to the
  // cookie-authenticated app APIs. Webhooks (/api/webhooks, HMAC-signed) and
  // cron (/api/cron, bearer-secret) live under other prefixes and are NOT
  // same-origin, so they're intentionally excluded. SameSite=Lax already
  // mitigates classic CSRF; this is a second, explicit layer.
  const CSRF_PROTECTED_PREFIXES = ["/api/admin", "/api/account", "/api/membership", "/api/partner"];
  if (
    isStateChangingMethod(request.method) &&
    CSRF_PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix)) &&
    !isSameOriginRequest(request)
  ) {
    return applySecurityHeaders(
      NextResponse.json(
        { success: false, error: "Invalid request origin" },
        { status: 403 },
      ),
    );
  }

  if (pathBypassesMaintenance(pathname)) {
    return applySecurityHeaders(NextResponse.next());
  }

  const maintenanceEnabled = await isMaintenanceEnabled();
  if (!maintenanceEnabled) {
    return applySecurityHeaders(NextResponse.next());
  }

  const isAdmin = await hasValidAdminSession(request);
  if (isAdmin) {
    return applySecurityHeaders(NextResponse.next());
  }

  if (pathname.startsWith("/api/")) {
    return applySecurityHeaders(
      NextResponse.json(
        { success: false, error: "Maintenance mode enabled" },
        { status: 503 },
      ),
    );
  }

  const rewriteUrl = request.nextUrl.clone();
  rewriteUrl.pathname = "/maintenance";
  rewriteUrl.search = "";
  return applySecurityHeaders(NextResponse.rewrite(rewriteUrl));
}

export const config = {
  matcher: "/:path*",
};
