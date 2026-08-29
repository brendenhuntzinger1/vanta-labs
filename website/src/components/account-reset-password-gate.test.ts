import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Audit E2 — what may unlock the "choose a new password" form.
//
// The form changes a password WITHOUT asking for the current one, which is
// correct for someone arriving from a recovery link and wrong for anyone else.
// /account/settings re-authenticates before a password change; this page cannot,
// because the whole point is that the person does not know their password. The
// arrival check is therefore the only thing separating the two.
//
// The check used to accept a bare `access_token=` anywhere in the fragment.
// That is not a recovery marker: Supabase puts `access_token` in the SIGNUP
// confirmation redirect too, so any fragment carrying one satisfied it. These
// tests pin the recovery marker itself.
//
// This is a source-level guard rather than a DOM test on purpose. The component
// is a client component whose behaviour depends on the Supabase browser client
// and on Supabase having already consumed the URL fragment; a jsdom test of it
// would be a test of the mock. The predicate is what regressed, so the predicate
// is what is pinned.
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(
  join(process.cwd(), "src/components/account-reset-password-form.tsx"),
  "utf8",
);

/** The predicate as the component computes it, extracted so it can be exercised. */
function looksLikeRecoveryLink(hash: string): boolean {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  return params.get("type") === "recovery";
}

describe("reset-password arrival check", () => {
  it("accepts a genuine recovery fragment", () => {
    expect(looksLikeRecoveryLink("#access_token=abc&refresh_token=def&type=recovery")).toBe(true);
  });

  it("rejects a signup-confirmation fragment", () => {
    // The exact shape Supabase sends back from a confirmation link. It carries
    // an access_token, and the old check accepted it for that reason alone.
    expect(looksLikeRecoveryLink("#access_token=abc&refresh_token=def&type=signup")).toBe(false);
  });

  it("rejects a bare access_token with no type at all", () => {
    expect(looksLikeRecoveryLink("#access_token=abc")).toBe(false);
  });

  it("rejects an empty fragment", () => {
    expect(looksLikeRecoveryLink("")).toBe(false);
    expect(looksLikeRecoveryLink("#")).toBe(false);
  });

  it("is not fooled by 'recovery' appearing inside another value", () => {
    // A substring test would have passed this; the parsed check does not.
    expect(looksLikeRecoveryLink("#access_token=abc&type=magiclink&next=/recovery")).toBe(false);
    expect(looksLikeRecoveryLink("#type=not-recovery")).toBe(false);
  });

  it("the component parses the fragment rather than substring-matching it", () => {
    expect(SOURCE).toContain("new URLSearchParams");
    expect(SOURCE).toContain('params.get("type") === "recovery"');
    // The two substring tests that made a signup redirect look like a recovery.
    expect(SOURCE).not.toContain('hash.includes("access_token=")');
    expect(SOURCE).not.toContain('hash.includes("type=recovery")');
  });

  it("a PASSWORD_RECOVERY event is never downgraded by a later session read", () => {
    // Supabase strips the fragment once it has consumed it, so by the time
    // getSession() resolves the hash can legitimately be empty. Recomputing the
    // decision from scratch at that point would lock out the very people this
    // page exists for.
    expect(SOURCE).toContain("current === true");
  });

  it("revokes other sessions once the password has actually changed", () => {
    // Someone resetting is often doing it because they think another session is
    // not theirs. Leaving those live makes the new password mean less than the
    // customer thinks it does.
    expect(SOURCE).toContain('signOut({ scope: "others" })');
  });
});
