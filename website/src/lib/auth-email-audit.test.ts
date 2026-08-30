import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const inserted: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        inserted.push({ table, ...row });
        return { error: null };
      },
    }),
  },
}));

const { recordAuthEmailAttempt } = await import("@/lib/auth-email-audit");

// ---------------------------------------------------------------------------
// WAS THE EMAIL ACTUALLY SENT? — THE QUESTION THAT HAD NO ANSWER.
//
// A production account sat unconfirmed for days. Answering its alert required
// knowing whether the confirmation had been sent, and nothing recorded that:
// sendEmail() writes nothing, and neither the signup route nor the Supabase
// fallback wrote anything either. email_send_log and pending_emails were BOTH
// empty for that address whether the send had succeeded, failed, or never been
// attempted — three states with completely different responses, collapsed into
// one indistinguishable absence.
//
// These pin the record down, and then pin down that every auth path writes one,
// because a log that covers three of four paths is a log you cannot trust the
// silence of.
// ---------------------------------------------------------------------------

beforeEach(() => { inserted.length = 0; });

describe("the audit row", () => {
  it("records a successful send as sent, with no error stashed", async () => {
    await recordAuthEmailAttempt({ kind: "signup_confirmation", email: "a@example.com", success: true });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      table: "email_send_log",
      campaign_type: "auth:signup_confirmation",
      recipient_email: "a@example.com",
      template_key: "signup_confirmation",
      status: "sent",
      reference_id: null,
    });
  });

  it("keeps the provider's reason on a failure, which is what tells outages apart", async () => {
    await recordAuthEmailAttempt({
      kind: "password_reset", email: "b@example.com", success: false, error: "domain not verified",
    });
    expect(inserted[0]).toMatchObject({
      campaign_type: "auth:password_reset",
      status: "failed",
      reference_id: "domain not verified",
    });
  });

  it("never stores an unbounded provider error", async () => {
    await recordAuthEmailAttempt({
      kind: "password_reset", email: "c@example.com", success: false, error: "x".repeat(5000),
    });
    expect(String(inserted[0].reference_id).length).toBeLessThanOrEqual(200);
  });

  it("says 'unknown' rather than nothing when a failure carries no reason", async () => {
    await recordAuthEmailAttempt({ kind: "email_change", email: "d@example.com", success: false });
    expect(inserted[0].reference_id).toBe("unknown");
  });

  it("namespaces under auth: so it never collides with a campaign type", async () => {
    await recordAuthEmailAttempt({ kind: "signup_confirmation_resend", email: "e@example.com", success: true });
    expect(String(inserted[0].campaign_type).startsWith("auth:")).toBe(true);
  });

  it("cannot take a send down with it", async () => {
    // The insert throwing must never propagate — the email has already gone.
    const { supabaseAdmin } = await import("@/lib/supabase-server");
    const original = supabaseAdmin.from;
    (supabaseAdmin as unknown as { from: unknown }).from = () => { throw new Error("db down"); };
    await expect(
      recordAuthEmailAttempt({ kind: "signup_confirmation", email: "f@example.com", success: true }),
    ).resolves.toBeUndefined();
    (supabaseAdmin as unknown as { from: unknown }).from = original;
  });
});

// ---------------------------------------------------------------------------
// Every auth send has to write one, or the absence of a row stops meaning
// anything. Source-level, because these are separate routes and modules and the
// point is that none of them was missed.
// ---------------------------------------------------------------------------

describe("every auth email path records its attempt", () => {
  // THE HAND-WRITTEN LIST IS WHAT LET ONE THROUGH.
  //
  // This used to name three files and check each contained the call. It passed,
  // and it was wrong: /api/account/email-change also sends an auth email and
  // recorded nothing — despite "email_change" being a declared AuthEmailKind
  // and exercised in the tests above. A list you maintain by hand only ever
  // covers what you remembered.
  //
  // So the list is derived instead: every file that calls sendEmail AND is an
  // auth path has to record its attempt. A new auth route fails this the day it
  // is added rather than the day someone goes looking for a missing email.
  const SRC = join(process.cwd(), "src");

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  /** An email a customer is BLOCKED by until it arrives. */
  const AUTH_PATH = /(^|\/)(auth|account)(\/|-)|auth-confirmation-email/;

  /**
   * Comments are stripped before looking for the call.
   *
   * Three files DISCUSS sendEmail() in prose — the resend route, the auth form
   * and auth-health.ts all explain what does and does not go through it — and a
   * raw substring search flagged every one of them as an unlogged sender. A
   * check with false positives gets its failures waved away, which is how the
   * real one would have been waved away too.
   */
  const codeOf = (file: string) => readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  const authSenders = walk(SRC)
    .filter((f) => /\bsendEmail\s*\(/.test(codeOf(f)) && AUTH_PATH.test(f.replace(SRC, "")))
    .map((f) => f.replace(`${process.cwd()}/`, ""));

  it("finds the auth senders at all, so an empty sweep cannot pass silently", () => {
    expect(authSenders.length).toBeGreaterThanOrEqual(4);
  });

  for (const path of authSenders) {
    it(`${path} records its send`, () => {
      expect(codeOf(join(process.cwd(), path)),
        `${path} sends an auth email and records nothing — a customer blocked by it `
        + "cannot be told whether it was ever sent").toContain("recordAuthEmailAttempt");
    });
  }

  it("the signup route records the failure branch too, not just the happy one", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/auth/signup/route.ts"), "utf8");
    // Both the app's own send and the Supabase fallback leave a row, so an
    // operator can see WHICH sender the customer's link came from.
    expect(src).toContain("signup_confirmation_supabase_fallback");
  });
});
