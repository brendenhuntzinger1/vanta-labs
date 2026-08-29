"use client";

import { useEffect } from "react";

import { isActionablePasswordSetupLink } from "@/lib/auth-link-fragment";

// ---------------------------------------------------------------------------
// Catch a password-setup link that GoTrue delivered to the wrong page.
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
// INVITES LAND HERE TOO, AND USED NOT TO BE CARRIED.
//
// An admin invite (createPartnerInvite -> auth.admin.inviteUserByEmail) comes
// back as `type=invite`, and this component forwarded only `type=recovery`. So
// an invited ambassador — who has NO password, because that is what
// inviteUserByEmail creates — clicked their link, landed on the storefront, and
// had no route to a form that could give them one. createPartnerInvite now
// names the redirect explicitly as well; this stays the safety net for the
// allowlist gap, exactly as it is for recovery.
//
// So: on any page, if a password-setup fragment shows up where no such form
// exists, carry it to the page that does. The fragment is passed through
// untouched — it is what the Supabase client reads to establish the session,
// and this component deliberately does not parse, store or transmit it.
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
    // Recovery or invite, and only when it actually carries a token: a
    // fragment with no `access_token` is nothing to act on.
    if (!isActionablePasswordSetupLink(hash)) return;

    // replace(), not assign(): the misdirected URL should not sit in history
    // where a back-navigation would replay a one-time token.
    window.location.replace(`${RESET_PATH}${hash}`);
  }, []);

  return null;
}
