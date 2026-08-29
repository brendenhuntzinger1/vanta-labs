import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isActionablePasswordSetupLink } from "@/lib/auth-link-fragment";
import { ambassadorInviteTemplate } from "@/lib/email/templates";

// ---------------------------------------------------------------------------
// WHERE AN ADMIN INVITE LANDS — the affiliate half of the 2026-08-29
// signup_confirmation_stalled alert.
//
// auth.admin.inviteUserByEmail creates the auth user with `encrypted_password`
// NULL. The invite link is therefore the ONLY way that person ever gets a
// password, and there were three separate places it could die:
//
//   1. createPartnerInvite passed no `redirectTo`, so GoTrue fell back to the
//      project's Site URL — the storefront home page.
//   2. RecoveryLinkCatcher forwarded only `type=recovery`, so nothing carried
//      an invite fragment off that page.
//   3. The reset form unlocked only on `type=recovery`, so even a hand-typed
//      invite URL was refused.
//
// Production: ambassador ZAIN, invited 2026-08-23, approved an hour later with
// a live referral code, and six days on still had no password, no confirmation
// and no sign-in. The only invited account in the project's history, and the
// only one stuck — every other ambassador came through the storefront signup
// and confirmed within a minute, which is what rules out the sender.
//
// These are source-level guards on purpose. Two of the three hops are client
// components whose behaviour depends on the Supabase browser client having
// already consumed a URL fragment, and the third is a Supabase admin call; a
// jsdom or mocked test of any of them would be a test of the mock. The
// PREDICATE is executed for real (it lives in lib/auth-link-fragment.ts and is
// imported by both components and by this file), and what is pinned below is
// the wiring around it that regressed.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const PARTNER_PORTAL = read("src/lib/partner-portal.ts");
const CATCHER = read("src/components/recovery-link-catcher.tsx");
const RESET_FORM = read("src/components/account-reset-password-form.tsx");

describe("hop 1 — the invite names where it lands", () => {
  it("createPartnerInvite passes a redirectTo", () => {
    // Without it GoTrue uses the Site URL, and the storefront home page has
    // nothing that can read an invite fragment.
    expect(PARTNER_PORTAL).toContain("redirectTo:");
  });

  it("that redirect points at the set-a-password page", () => {
    expect(PARTNER_PORTAL).toContain("/account/reset-password");
  });

  it("it is built from the configured site URL rather than hardcoded", () => {
    // The invite send moved into inviteAmbassadorUser(), so the redirect is now
    // built once at the call site and threaded through. The property under test
    // is unchanged: it comes from NEXT_PUBLIC_SITE_URL, not a literal host.
    expect(PARTNER_PORTAL).toContain("redirectTo: `${getSiteUrl()}/account/reset-password`");
    expect(PARTNER_PORTAL).not.toContain("redirectTo: \"https://");
  });
});

describe("hop 2 — a misdirected fragment is carried to the form", () => {
  it("the catcher uses the shared predicate, so it accepts invites too", () => {
    // The Redirect URLs allowlist lives in the Supabase dashboard and cannot be
    // asserted from here. When the entry is missing GoTrue silently falls back
    // to the Site URL, so hop 1 alone is not enough — this is the safety net.
    expect(CATCHER).toContain("isActionablePasswordSetupLink");
    expect(CATCHER).toContain('from "@/lib/auth-link-fragment"');
  });

  it("no longer hardcodes the recovery-only check it used to", () => {
    expect(CATCHER).not.toContain('params.get("type") !== "recovery"');
  });

  it("still forwards to the reset page, preserving the fragment untouched", () => {
    expect(CATCHER).toContain("/account/reset-password");
    expect(CATCHER).toContain("${RESET_PATH}${hash}");
  });

  it("replaces rather than pushes, so a one-time token is not left in history", () => {
    expect(CATCHER).toContain("window.location.replace");
    expect(CATCHER).not.toContain("window.location.assign");
  });

  it("the predicate it uses requires a token, not just a type marker", () => {
    expect(isActionablePasswordSetupLink("#type=invite")).toBe(false);
    expect(isActionablePasswordSetupLink("#access_token=abc&type=invite")).toBe(true);
  });
});

describe("hop 3 — the form unlocks for an invite", () => {
  it("uses the shared predicate rather than a recovery-only copy", () => {
    expect(RESET_FORM).toContain("isPasswordSetupLink");
    expect(RESET_FORM).not.toContain('params.get("type") === "recovery"');
  });
});

describe("the widening that must NOT happen", () => {
  it("a signup confirmation is still not a password-setup link", () => {
    // A confirmation redirect carries an access_token exactly like the other
    // two. Accepting it would hand a change-password-without-the-current-one
    // form to anyone who just confirmed an email — the widening audit E2 closed.
    expect(isActionablePasswordSetupLink("#access_token=abc&refresh_token=def&type=signup")).toBe(false);
  });

  it("the form does not open on a bare SIGNED_IN event", () => {
    // Invites arrive as SIGNED_IN rather than PASSWORD_RECOVERY, which makes
    // that event a tempting second unlock. It is not one: every ordinary signed
    // in visitor fires it too, and /account/settings re-authenticates before a
    // password change precisely so this page cannot be used to skip that.
    expect(RESET_FORM).not.toContain('"SIGNED_IN"');
  });
});

// ---------------------------------------------------------------------------
// hop 0 — the invite email itself.
//
// Fixing where the link LANDS is worth nothing if the message carrying it gets
// filed as phishing, which is what happened to the signup confirmations on
// 2026-08-29: Resend reported "delivered" for every stuck account and not one
// was ever clicked. The invite went out through the same Supabase mailer, in
// the same bare-anchor shape, and it matters more here — inviteUserByEmail
// creates the account with NO password, so this link is the only way in.
// ---------------------------------------------------------------------------

describe("hop 0 — the invite is ours to send, and branded", () => {
  it("mints the invite link instead of letting Supabase mail it", () => {
    expect(PARTNER_PORTAL).toContain("generateLink");
    expect(PARTNER_PORTAL).toContain('type: "invite"');
  });

  it("sends it with the branded template through the app's own provider", () => {
    expect(PARTNER_PORTAL).toContain("ambassadorInviteTemplate");
    expect(PARTNER_PORTAL).toContain("sendAmbassadorEmail");
  });

  it("still falls back to inviteUserByEmail, so the change is additive", () => {
    // Moving a send in-house makes our provider a new single point of failure
    // for an ambassador's only route into their account.
    expect(PARTNER_PORTAL).toContain("inviteUserByEmail");
    expect(PARTNER_PORTAL).toContain("partner_invite_provider_failed");
  });
});

describe("the invite email", () => {
  const template = ambassadorInviteTemplate({
    name: "Zain",
    inviteUrl: "https://example.test/verify?token=abc&type=invite",
    commissionPercent: 20,
  });

  it("carries the link as a real button, not a naked anchor", () => {
    expect(template.html).toContain("https://example.test/verify?token=abc&amp;type=invite");
    expect(template.html).toContain("border-radius:999px");
    expect(template.html).toContain("Set my password");
  });

  it("is branded, which is the whole difference from the one that got filtered", () => {
    expect(template.html).toContain("Vanta Labs");
    expect(template.html).toContain("background:#050505");
  });

  it("says what to do when the single-use link expires", () => {
    // The failure mode that stranded ZAIN for six days: a dead link and no
    // stated way back.
    expect(template.html).toContain("Forgot your password?");
    expect(template.text).toContain("Forgot your password?");
  });

  it("states the commission rate when the admin set one", () => {
    expect(template.html).toContain("20%");
    const noRate = ambassadorInviteTemplate({ name: "Zain", inviteUrl: "https://example.test/x" });
    expect(noRate.html).not.toContain("commission rate is set to");
  });

  it("carries the link in the plain-text part too", () => {
    expect(template.text).toContain("https://example.test/verify?token=abc&type=invite");
  });
});
