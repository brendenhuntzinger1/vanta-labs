import "server-only";

/**
 * Server-side Cloudflare Turnstile verification.
 *
 * WHY THIS EXISTS. Until now every CAPTCHA token in this app was handed
 * straight to Supabase Auth, which verified it only if CAPTCHA protection was
 * switched on in the Supabase dashboard. That works while every auth call goes
 * directly to Supabase from the browser. Password reset no longer does — it
 * goes through our own route so the email can be branded, retried and watched
 * (see /api/auth/password-reset) — so the token has to be checked HERE or it
 * is not checked at all.
 *
 * FAILS OPEN WHEN UNCONFIGURED, ON PURPOSE. Turnstile is optional in this
 * deployment: no secret set means the whole layer is a no-op, exactly as the
 * client widget is a no-op without a site key. Making an unset secret reject
 * every request would turn "we haven't set up CAPTCHA yet" into "nobody can
 * reset their password", which is the failure this file is meant to prevent.
 *
 * FAILS OPEN ON A NETWORK ERROR TOO. Cloudflare being unreachable must not
 * take password recovery down with it. The endpoints that call this are
 * independently rate limited, which is the control that actually holds when
 * the CAPTCHA cannot be consulted.
 *
 * It does NOT fail open on a verdict. A token that Cloudflare actively
 * rejects — expired, replayed, forged — is refused.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5_000;

export type TurnstileOutcome =
  /** No secret configured — the check is switched off for this deployment. */
  | { ok: true; reason: "not-configured" }
  /** Cloudflare confirmed the token. */
  | { ok: true; reason: "verified" }
  /** Cloudflare could not be reached; the rate limiter is the remaining control. */
  | { ok: true; reason: "unreachable" }
  /** Cloudflare rejected the token, or the caller sent none while configured. */
  | { ok: false; reason: "rejected" | "missing"; codes?: string[] };

export function turnstileIsConfigured(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY?.trim());
}

export async function verifyTurnstileToken(
  token: string | null | undefined,
  remoteIp?: string | null,
): Promise<TurnstileOutcome> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) {
    return { ok: true, reason: "not-configured" };
  }

  const candidate = typeof token === "string" ? token.trim() : "";
  if (!candidate) {
    return { ok: false, reason: "missing" };
  }

  const body = new URLSearchParams({ secret, response: candidate });
  if (remoteIp) {
    body.set("remoteip", remoteIp);
  }

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      cache: "no-store",
    });

    if (!response.ok) {
      // A 5xx from Cloudflare is an outage, not a verdict on this visitor.
      return { ok: true, reason: "unreachable" };
    }

    const json = (await response.json()) as { success?: unknown; "error-codes"?: unknown };
    if (json?.success === true) {
      return { ok: true, reason: "verified" };
    }

    const codes = Array.isArray(json?.["error-codes"])
      ? (json["error-codes"] as unknown[]).filter((code): code is string => typeof code === "string")
      : undefined;
    return { ok: false, reason: "rejected", codes };
  } catch {
    // Timeout, DNS, TLS — an outage on Cloudflare's side.
    return { ok: true, reason: "unreachable" };
  }
}
