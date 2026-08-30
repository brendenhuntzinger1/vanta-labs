import "server-only";

import { cookies } from "next/headers";
import { createServerClient } from "@/lib/supabase-server";
import { AUTH_COOKIE_NAME, authCookieOptions, decodeAuthCookie, encodeAuthCookie } from "@/lib/auth-cookie";

export { AUTH_COOKIE_NAME };

export async function getSessionCookie() {
  const store = await cookies();
  return decodeAuthCookie(store.get(AUTH_COOKIE_NAME)?.value);
}

export async function getSessionAccessToken() {
  return (await getSessionCookie())?.accessToken ?? null;
}

export async function getAuthenticatedUser() {
  const tokens = await getSessionCookie();
  if (!tokens) {
    return null;
  }

  try {
    const supabaseAuthClient = createServerClient();
    const { data, error } = await supabaseAuthClient.auth.getUser(tokens.accessToken);

    if (!error && data.user) {
      return data.user;
    }

    // THE ACCESS TOKEN LAPSED, WHICH USED TO MEAN "SIGNED OUT".
    //
    // A "keep me signed in" cookie lives 30 days; the JWT inside it lives an
    // hour. Middleware rotates the pair on the way in, so by the time a render
    // gets here the token is normally fresh — but a render can still outrun it
    // (a route middleware skips, a token that expired between the two), and on
    // that path the customer was silently signed out mid-session.
    //
    // Refreshing here fixes the render. The COOKIE is not written back: a
    // server component cannot set one, and Next throws if it tries. Middleware
    // owns that write and will do it on the next request.
    if (!tokens.refreshToken) {
      return null;
    }

    const refreshed = await supabaseAuthClient.auth.refreshSession({ refresh_token: tokens.refreshToken });
    return refreshed.data?.user ?? null;
  } catch {
    // Never throw on a transient auth-backend failure (network/DNS/timeout).
    // This helper gates almost every server component; callers treat null as
    // "logged out", so a Supabase blip degrades to a signed-out view instead of
    // crashing every authenticated page. Same resilience posture as middleware.
    return null;
  }
}

/**
 * The cookie to set for a freshly established session.
 *
 * `refreshToken` is optional only so an older caller still compiles; without it
 * the cookie keeps its previous shape and its previous one-hour ceiling, which
 * is precisely the bug. Every caller in this repo passes one.
 */
export function buildAuthCookieValue(accessToken: string, rememberMe = true, refreshToken?: string | null) {
  return {
    name: AUTH_COOKIE_NAME,
    value: encodeAuthCookie({ accessToken, refreshToken: refreshToken ?? null, rememberMe }),
    options: authCookieOptions(rememberMe),
  };
}

export function buildExpiredAuthCookie() {
  return {
    name: AUTH_COOKIE_NAME,
    value: "",
    options: { ...authCookieOptions(false), maxAge: 0 },
  };
}
