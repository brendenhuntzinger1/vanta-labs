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
  // storefront and expected for anything handling payment/auth. (CSP is a
  // separate, iterative hardening step — see the audit backlog.)
  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
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
    select: "id",
    token_hash: `eq.${tokenHash}`,
    expires_at: `gt.${new Date().toISOString()}`,
    limit: "1",
  });

  const response = await fetch(`${config.url}/rest/v1/admin_sessions?${query.toString()}`, {
    headers: {
      apikey: config.serviceRole,
      Authorization: `Bearer ${config.serviceRole}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    sessionCache.set(token, { value: false, expiresAt: now + SESSION_CACHE_TTL_MS });
    return false;
  }

  const rows = (await response.json()) as Array<{ id: string }>;
  const valid = rows.length > 0;
  sessionCache.set(token, { value: valid, expiresAt: now + SESSION_CACHE_TTL_MS });
  return valid;
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

  if (pathname.startsWith("/api/admin") && isStateChangingMethod(request.method) && !isSameOriginRequest(request)) {
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
