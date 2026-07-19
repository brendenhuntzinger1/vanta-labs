import "server-only";

import { randomBytes, scryptSync, timingSafeEqual, createHash } from "crypto";
import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase-server";

export const ADMIN_SESSION_COOKIE = "vl_admin_session";
const ADMIN_SESSION_HOURS = 12;
const MAX_FAILED_ATTEMPTS = 6;
const LOGIN_WINDOW_MINUTES = 15;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function getSessionTokenFromCookieHeader(cookieHeader: string | null | undefined) {
  if (!cookieHeader) {
    return null;
  }

  const parts = cookieHeader.split(";").map((part) => part.trim());
  const match = parts.find((part) => part.startsWith(`${ADMIN_SESSION_COOKIE}=`));
  if (!match) {
    return null;
  }

  return decodeURIComponent(match.split("=").slice(1).join("="));
}

function verifyPassword(password: string, salt: string, hashHex: string) {
  const derived = scryptSync(password, salt, 64);
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== derived.length) {
    return false;
  }
  return timingSafeEqual(derived, expected);
}

function sessionExpiryIso() {
  const expires = new Date();
  expires.setHours(expires.getHours() + ADMIN_SESSION_HOURS);
  return expires.toISOString();
}

function loginWindowStartIso() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - LOGIN_WINDOW_MINUTES);
  return date.toISOString();
}

function normalizeIpAddress(raw: string | null | undefined) {
  if (!raw) {
    return null;
  }
  return raw.split(",")[0]?.trim() || null;
}

export function getRequestIpAddress(request: Request) {
  return normalizeIpAddress(
    request.headers.get("x-forwarded-for")
    ?? request.headers.get("x-real-ip")
    ?? null,
  );
}

export function getRequestUserAgent(request: Request) {
  return request.headers.get("user-agent") ?? null;
}

export function buildAdminSessionCookie(token: string) {
  return {
    name: ADMIN_SESSION_COOKIE,
    value: token,
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict" as const,
      path: "/",
    },
  };
}

export function buildExpiredAdminSessionCookie() {
  return {
    name: ADMIN_SESSION_COOKIE,
    value: "",
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      path: "/",
      maxAge: 0,
    },
  };
}

export async function createAdminSession(input: { username: string; ipAddress?: string | null; userAgent?: string | null }) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);

  const { error } = await supabaseAdmin.from("admin_sessions").insert({
    username: input.username,
    token_hash: tokenHash,
    expires_at: sessionExpiryIso(),
    ip_address: input.ipAddress ?? null,
    user_agent: input.userAgent ?? null,
    last_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  });

  if (error) {
    throw error;
  }

  return token;
}

export async function destroyAdminSession(token: string | null | undefined) {
  if (!token) {
    return;
  }

  const tokenHash = hashToken(token);
  await supabaseAdmin.from("admin_sessions").delete().eq("token_hash", tokenHash);
}

export async function verifyAdminSessionToken(token: string | null | undefined) {
  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);
  const nowIso = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("admin_sessions")
    .select("id, username, expires_at")
    .eq("token_hash", tokenHash)
    .gt("expires_at", nowIso)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  await supabaseAdmin
    .from("admin_sessions")
    .update({ last_seen_at: nowIso })
    .eq("id", data.id);

  return { id: String(data.id), username: String(data.username) };
}

export async function verifyAdminSessionFromCookie() {
  const store = await cookies();
  const token = store.get(ADMIN_SESSION_COOKIE)?.value ?? null;
  return verifyAdminSessionToken(token);
}

export async function verifyAdminSessionFromRequest(request: Request) {
  const token = getSessionTokenFromCookieHeader(request.headers.get("cookie"));
  return verifyAdminSessionToken(token);
}

export async function validateAdminCredentials(usernameRaw: string, passwordRaw: string) {
  const username = usernameRaw.trim().toLowerCase();
  const password = passwordRaw;

  const { data, error } = await supabaseAdmin
    .from("admin_credentials")
    .select("username, password_salt, password_hash, is_active")
    .eq("username", username)
    .eq("is_active", true)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const isValid = verifyPassword(password, String(data.password_salt), String(data.password_hash));
  if (!isValid) {
    return null;
  }

  return { username: String(data.username) };
}

export async function canAttemptAdminLogin(input: { username: string; ipAddress?: string | null }) {
  const username = input.username.trim().toLowerCase();
  const ipAddress = normalizeIpAddress(input.ipAddress);
  const windowStart = loginWindowStartIso();

  const [{ data: usernameAttempts, error: usernameError }, { data: ipAttempts, error: ipError }] = await Promise.all([
    supabaseAdmin
      .from("admin_login_attempts")
      .select("attempted_at")
      .eq("username", username)
      .eq("success", false)
      .gte("attempted_at", windowStart),
    ipAddress
      ? supabaseAdmin
          .from("admin_login_attempts")
          .select("attempted_at")
          .eq("ip_address", ipAddress)
          .eq("success", false)
          .gte("attempted_at", windowStart)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (usernameError) {
    throw usernameError;
  }

  if (ipError) {
    throw ipError;
  }

  const latestFailedAttemptIso = [...(usernameAttempts ?? []), ...(ipAttempts ?? [])]
    .map((row) => row.attempted_at)
    .filter((value): value is string => typeof value === "string")
    .sort()
    .at(-1);

  const failedCount = Math.max(usernameAttempts?.length ?? 0, ipAttempts?.length ?? 0);
  if (failedCount < MAX_FAILED_ATTEMPTS) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (!latestFailedAttemptIso) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const windowEndsAt = new Date(latestFailedAttemptIso).getTime() + LOGIN_WINDOW_MINUTES * 60 * 1000;
  const retryAfterMs = Math.max(0, windowEndsAt - Date.now());

  if (retryAfterMs <= 0) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  return {
    allowed: false,
    retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
  };
}

export async function recordAdminLoginAttempt(input: {
  username: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  success: boolean;
}) {
  const username = input.username.trim().toLowerCase();
  const ipAddress = normalizeIpAddress(input.ipAddress);

  const { error } = await supabaseAdmin.from("admin_login_attempts").insert({
    username,
    ip_address: ipAddress,
    user_agent: input.userAgent ?? null,
    success: input.success,
    attempted_at: new Date().toISOString(),
  });

  if (error) {
    throw error;
  }
}
