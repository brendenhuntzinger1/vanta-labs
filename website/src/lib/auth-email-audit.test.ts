import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const inserted: Array<Record<string, unknown>> = [];

// Rows already in email_send_log when the call is made. recordAuthEmailAttempt
// now CLOSES a claim written by claimAuthEmailSend() before falling back to an
// insert, so the fake has to model both halves — an update-only fake reports a
// missing insert, and an insert-only fake (which this was) reports nothing at
// all, because the update it cannot answer throws into the swallow-everything
// catch. Neither failure is in the product.
const existing: Array<Record<string, unknown>> = [];

/** What the NEXT insert reports back, so the duplicate branch is reachable. */
let nextInsertError: { code: string } | null = null;

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        inserted.push({ table, ...row });
        const error = nextInsertError;
        nextInsertError = null;
        return { error };
      },
      // .update(patch).eq(...).eq(...).eq(...).select("id") — supabase-js
      // applies the filters as they chain, so the fake must chain too rather
      // than deciding anything at update() time.
      update: (patch: Record<string, unknown>) => {
        const filters: Array<[string, unknown]> = [];
        const builder = {
          eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
          select: async () => {
            const matched = existing.filter((row) => filters.every(([c, v]) => row[c] === v));
            for (const row of matched) Object.assign(row, patch);
            return { data: matched.map((row) => ({ id: row.id })), error: null };
          },
        };
        return builder;
      },
    }),
  },
}));

const { recordAuthEmailAttempt, claimAuthEmailSend } = await import("@/lib/auth-email-audit");


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

beforeEach(() => { inserted.length = 0; existing.length = 0; nextInsertError = null; });

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
// THE CLAIM — WHY A SECOND COPY OF THE SAME EMAIL IS WORSE THAN NOISE.
//
// A double-clicked signup used to send two confirmations and three clicks of
// "resend" sent three. Each carries a DIFFERENT token, so opening any but the
// newest gives "I got the email but the link doesn't work" — which is what
// customers actually reported, alongside the repeated mail itself.
//
// The claim is an INSERT against a partial unique index (one row per kind, per
// address, per minute — sql/auth-email-debounce.sql), so the exclusion happens
// in the database and holds across processes, where two Vercel lambdas racing
// on one double-click actually live. An in-process guard would not have.
// ---------------------------------------------------------------------------

describe("claiming the once-a-minute slot", () => {
  it("writes the row as 'sending', not 'sent'", async () => {
    // 'sent' up front would be a lie until the send returns, and — because
    // 'failed' is outside the index — it would also lock someone who received
    // NOTHING out of retrying for the rest of the minute.
    expect(await claimAuthEmailSend("signup_confirmation", "a@example.com")).toBe(true);
    expect(inserted[0]).toMatchObject({
      table: "email_send_log",
      campaign_type: "auth:signup_confirmation",
      recipient_email: "a@example.com",
      status: "sending",
    });
  });

  it("refuses the send when the index says somebody already took the slot", async () => {
    nextInsertError = { code: "23505" };
    expect(await claimAuthEmailSend("password_reset", "b@example.com")).toBe(false);
  });

  it("FAILS OPEN on any other database error", async () => {
    // An un-migrated database, or a transport blip, must not silence the
    // confirmation email: a customer who never receives it is locked out of the
    // account they just created, which is strictly worse than a duplicate.
    nextInsertError = { code: "08006" };
    expect(await claimAuthEmailSend("signup_confirmation", "c@example.com")).toBe(true);
  });

  it("debounces against the key it is given, not its own kind", async () => {
    // A double-clicked signup does not take the same route twice: the second
    // request finds the address registered and would send the RESEND. Two
    // kinds, two slots, two emails from one double-click — unless they collide
    // on one key, which is what this argument is for.
    await claimAuthEmailSend("signup_confirmation_resend", "d@example.com", "signup_confirmation");
    expect(inserted[0]).toMatchObject({
      campaign_type: "auth:signup_confirmation",
      template_key: "signup_confirmation_resend",
    });
  });
});

describe("closing the claim rather than writing a second row", () => {
  it("updates the 'sending' row in place, leaving no duplicate", async () => {
    existing.push({
      id: 7, campaign_type: "auth:signup_confirmation",
      recipient_email: "e@example.com", status: "sending",
    });

    await recordAuthEmailAttempt({ kind: "signup_confirmation", email: "e@example.com", success: true });

    expect(inserted, "inserted a second row instead of closing the claim it already had").toHaveLength(0);
    expect(existing[0]).toMatchObject({ status: "sent", reference_id: null });
  });

  it("closes a failed send as 'failed', which frees the slot immediately", async () => {
    // 'failed' is outside the partial unique index on purpose. A customer whose
    // email did not go must be able to ask again now, not in sixty seconds.
    existing.push({
      id: 8, campaign_type: "auth:password_reset",
      recipient_email: "f@example.com", status: "sending",
    });

    await recordAuthEmailAttempt({
      kind: "password_reset", email: "f@example.com", success: false, error: "domain not verified",
    });

    expect(existing[0]).toMatchObject({ status: "failed", reference_id: "domain not verified" });
  });

  it("still inserts when there is no claim to close", async () => {
    // Not every recorded attempt is claimed — the Supabase fallback records one
    // without ever taking a slot. Losing those rows would put the audit log
    // back where it started.
    await recordAuthEmailAttempt({
      kind: "signup_confirmation_supabase_fallback", email: "g@example.com", success: true,
    });
    expect(inserted).toHaveLength(1);
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
