"use client";

import { useEffect } from "react";

// ---------------------------------------------------------------------------
// Catch a password-recovery link that GoTrue delivered to the wrong page.
//
// WHY (audit E6). Supabase only honours a `redirect_to` that appears in the
// project's Redirect URLs allowlist. If
// `https://<site>/account/reset-password` is missing from it — a dashboard
// setting that lives nowhere in this repo and cannot be asserted by any test —
// GoTrue silently falls back to the project's Site URL. The customer clicks a
// valid reset link, lands on the HOME PAGE with
// `#access_token=...&type=recovery` in the address bar, sees an ordinary
// storefront, and concludes password reset is broken. Nothing logs it.
//
// Production evidence that this is worth defending against: in the site's
// entire history exactly one password reset has ever been requested, and its
// recovery token is still unspent a month later.
//
// So: on any page, if a recovery fragment shows up where no reset form exists,
// carry it to the page that does. The fragment is passed through untouched —
// it is what the Supabase client reads to establish the recovery session, and
// this component deliberately does not parse, store or transmit it.
//
// This is a safety net, not the fix. The allowlist entry should still be set;
// with it, this code never runs.
// ---------------------------------------------------------------------------

const RESET_PATH = "/account/reset-password";

export function RecoveryLinkCatcher() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Already where it belongs — the reset form handles it from here.
    if (window.location.pathname === RESET_PATH) return;

    const hash = window.location.hash;
    if (!hash || hash.length < 2) return;

    const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    if (params.get("type") !== "recovery") return;
    // A recovery fragment without tokens is nothing to act on.
    if (!params.get("access_token")) return;

    // replace(), not assign(): the misdirected URL should not sit in history
    // where a back-navigation would replay a one-time token.
    window.location.replace(`${RESET_PATH}${hash}`);
  }, []);

  return null;
}
