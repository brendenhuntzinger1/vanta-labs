// ---------------------------------------------------------------------------
// THE COOKIE THAT OUTLIVED ITS OWN CONTENTS.
//
// "Keep me signed in on this device" set a 30-day cookie whose entire value was
// a raw Supabase access JWT. Those expire in an hour by default (a week at the
// very most), and nothing anywhere refreshed one: no refresh token was stored,
// and there is no TOKEN_REFRESHED listener pushing the browser client's rotated
// token back into the cookie. Every server render calls getUser(accessToken),
// which starts failing the moment the JWT lapses — so the checkbox promised
// thirty days and delivered sixty minutes, after which the customer is silently
// signed out mid-session.
//
// It is also what made the shared-browser hazard on the login page reachable at
// all: our cookie expired hourly while supabase-js kept a self-refreshing
// session in localStorage for weeks, so "signed out here, still signed in
// there" was the normal state of a returning customer rather than an edge case.
//
// So the cookie now carries the refresh token alongside the access token, and
// middleware rotates the pair when the access half expires.
//
// DELIBERATELY NOT `server-only`. Middleware is where the rotation happens and
// it cannot import a server-only module; the encoding has to be shared with it
// or the two would drift.
//
// This file does no crypto and makes no security claim of its own. The cookie
// is httpOnly, Secure and SameSite=Lax, which is what keeps it out of reach of
// script and of cross-site requests; base64url here is packaging, not
// protection, and nothing in it should ever be treated as such.
// ---------------------------------------------------------------------------

export const AUTH_COOKIE_NAME = "vl_session_token";

/** "Remember me" keeps the session cookie for 30 days on a trusted device. */
export const AUTH_COOKIE_REMEMBER_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * Refresh once the access token has under this long to live.
 *
 * Not zero: a token that expires during the render it was checked in is a
 * signed-out page for no reason. A minute covers the round trip with room to
 * spare and costs nothing, because the check itself is local.
 */
export const ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 60;

export interface AuthSessionTokens {
  accessToken: string;
  /** Absent for a cookie written before this envelope existed. */
  refreshToken: string | null;
  /**
   * Whether this was a "keep me signed in" session.
   *
   * Carried INSIDE the value because a browser sends back only `name=value` —
   * never the attributes. Without it the rotation below could not tell a
   * persistent cookie from a session one, and every refresh would have to guess
   * (and so silently promote a browser-close session into a 30-day one, or
   * demote a remembered device on its first refresh).
   */
  rememberMe: boolean;
}

function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Prefix that tells an envelope apart from a legacy bare JWT. */
const ENVELOPE_PREFIX = "v2.";

export function encodeAuthCookie(tokens: AuthSessionTokens): string {
  if (!tokens.refreshToken) {
    // Nothing to carry, so nothing to encode. Keeps the cookie readable and
    // means a caller that never supplies a refresh token behaves exactly as
    // before rather than silently changing shape.
    return tokens.accessToken;
  }
  return ENVELOPE_PREFIX + toBase64Url(JSON.stringify({
    a: tokens.accessToken,
    r: tokens.refreshToken,
    m: tokens.rememberMe ? 1 : 0,
  }));
}

/**
 * Read a cookie written by either version.
 *
 * A cookie set before this change holds a bare JWT and stays valid — customers
 * signed in at deploy time must not all be logged out by it. Those keep the old
 * behaviour (no refresh available) until their next sign-in writes an envelope.
 */
export function decodeAuthCookie(raw: string | null | undefined): AuthSessionTokens | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  if (!value.startsWith(ENVELOPE_PREFIX)) {
    // A legacy bare JWT. It cannot be refreshed and its own attributes are
    // unknowable from here, so it is reported as a remembered session — which
    // is what it was written as, and which changes nothing while there is no
    // refresh token to act on.
    return { accessToken: value, refreshToken: null, rememberMe: true };
  }

  try {
    const parsed = JSON.parse(fromBase64Url(value.slice(ENVELOPE_PREFIX.length)));
    const accessToken = typeof parsed?.a === "string" ? parsed.a : "";
    if (!accessToken) return null;
    return {
      accessToken,
      refreshToken: typeof parsed?.r === "string" && parsed.r ? parsed.r : null,
      rememberMe: parsed?.m !== 0,
    };
  } catch {
    // A corrupt cookie is a signed-out visitor, never a crash.
    return null;
  }
}

/**
 * The `exp` claim of a JWT, in epoch seconds, or null if it cannot be read.
 *
 * Decoded locally and deliberately NOT verified — this is used only to decide
 * whether to spend a network call refreshing. Every actual authentication
 * decision still goes through getUser(), which verifies the signature. Trusting
 * this for anything else would be trusting a value the holder can rewrite.
 */
export function accessTokenExpiresAt(accessToken: string): number | null {
  const segments = accessToken.split(".");
  if (segments.length !== 3) return null;
  try {
    const claims = JSON.parse(fromBase64Url(segments[1]));
    return typeof claims?.exp === "number" ? claims.exp : null;
  } catch {
    return null;
  }
}

/**
 * Whether this access token is spent, or close enough that it will be.
 *
 * A token whose `exp` cannot be read is reported as NOT expiring: refreshing on
 * an unreadable token would refresh on every request forever.
 */
export function accessTokenNeedsRefresh(accessToken: string, nowSeconds: number): boolean {
  const exp = accessTokenExpiresAt(accessToken);
  if (exp === null) return false;
  return exp - ACCESS_TOKEN_REFRESH_SKEW_SECONDS <= nowSeconds;
}

/** The cookie attributes, shared so the writer and the rotator cannot drift. */
export function authCookieOptions(rememberMe: boolean) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    // Remember me → a persistent 30-day cookie. Otherwise a session cookie
    // (no maxAge) that clears when the browser fully closes.
    ...(rememberMe ? { maxAge: AUTH_COOKIE_REMEMBER_MAX_AGE_SECONDS } : {}),
  };
}
