import "server-only";

import { cookies } from "next/headers";
import { createServerClient } from "@/lib/supabase-server";

export const AUTH_COOKIE_NAME = "vl_session_token";
// "Remember me" keeps the session cookie for 30 days on a trusted device.
const AUTH_COOKIE_REMEMBER_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export async function getSessionAccessToken() {
  const store = await cookies();
  return store.get(AUTH_COOKIE_NAME)?.value ?? null;
}

export async function getAuthenticatedUser() {
  const accessToken = await getSessionAccessToken();
  if (!accessToken) {
    return null;
  }

  const supabaseAuthClient = createServerClient();
  const { data, error } = await supabaseAuthClient.auth.getUser(accessToken);

  if (error || !data.user) {
    return null;
  }

  return data.user;
}

export function buildAuthCookieValue(accessToken: string, rememberMe = true) {
  return {
    name: AUTH_COOKIE_NAME,
    value: accessToken,
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      path: "/",
      // Remember me → a persistent 30-day cookie. Otherwise a session cookie
      // (no maxAge) that clears when the browser fully closes.
      ...(rememberMe ? { maxAge: AUTH_COOKIE_REMEMBER_MAX_AGE_SECONDS } : {}),
    },
  };
}

export function buildExpiredAuthCookie() {
  return {
    name: AUTH_COOKIE_NAME,
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
