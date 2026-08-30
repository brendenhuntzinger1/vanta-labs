import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { baseSentryOptions } from "@/lib/sentry-init";

// ---------------------------------------------------------------------------
// AN ALERT THAT NAMES THE WRONG SYSTEM, AND A HIGH-PRIORITY ERROR NOBODY CAN FIX.
//
// Both of these came out of reading the live Sentry issue list rather than the
// code, and both cost the same thing: an operator's attention during the
// minutes when something is actually wrong.
//
//   * `signup_confirmation_stalled` told whoever answered it that the
//     confirmation email is sent by Supabase Auth and is therefore absent from
//     the retry queue and the bounce webhook. Every clause of that stopped
//     being true when signup moved to generateLink + sendEmail, so the alert
//     was pointing at a system that is no longer in the path — during, of all
//     incidents, an email one.
//
//   * Snapchat's iOS webview throws a ReferenceError from its own injected
//     bridge script on /account/login. Sentry ranked it HIGH actionability. It
//     is unfixable third-party global code affecting zero users.
//
// Neither is a crash, which is why neither would ever be caught by a test that
// only asks whether the code runs.
// ---------------------------------------------------------------------------

// Two normalisations, and both are load-bearing.
//
// COMMENTS ARE STRIPPED because the fix's own comment quotes the wrong sentence
// verbatim to explain what was wrong with it — so a test reading raw source
// finds the old text in the very change that removed it, and fails forever.
//
// ADJACENT STRING LITERALS ARE JOINED because the message is concatenated
// across many lines; matching the raw source would otherwise depend on where
// the author happened to wrap. What is left is the sentence the operator reads.
const authHealth = readFileSync(join(process.cwd(), "src/lib/auth-health.ts"), "utf8")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/"\s*\+\s*"/g, "");

describe("the stalled-signup alert points at the system actually in the path", () => {
  it("no longer claims Supabase Auth sends the confirmation", () => {
    // The exact sentence that was wrong. Kept as a literal so a revert fails.
    expect(authHealth).not.toContain("Confirmation email is sent by Supabase Auth");
    expect(authHealth).not.toContain("check the Supabase project's SMTP");
  });

  it("no longer claims the send is absent from the retry queue and bounce webhook", () => {
    expect(authHealth).not.toContain("does not appear in the email retry queue");
  });

  it("names the table and the exact rows that answer 'was it sent?'", () => {
    // The alert is only worth anything if the thing it points at exists, which
    // is why recordAuthEmailAttempt was added at the same time.
    expect(authHealth).toContain("email_send_log");
    expect(authHealth).toContain("auth:signup_confirmation");
    expect(authHealth).toContain("email_suppressions");
    expect(authHealth).toContain("the sending domain's reputation");
  });

  it("distinguishes all three states, including the absent row", () => {
    expect(authHealth).toMatch(/status 'sent'/);
    expect(authHealth).toMatch(/'failed'/);
    expect(authHealth).toMatch(/NO row means the send was never/);
  });

  it("says the retry queue is NOT where to look, rather than sending them there", () => {
    expect(authHealth).toMatch(/not in the retry queue by design/);
  });

  it("still mentions Supabase, but as the fallback it now is", () => {
    expect(authHealth).toMatch(/falls? ?back to Supabase/i);
  });

  it("the per-domain note blames our sending domain, not the Supabase sender", () => {
    expect(authHealth).not.toContain("rejecting the Supabase Auth sender");
    expect(authHealth).toMatch(/spam-filing our sending domain/);
  });
});

describe("in-app browser bridge noise is filtered out of Sentry", () => {
  // baseSentryOptions refuses to build without a DSN, which is correct — it is
  // the thing that made a silently-unarmed browser client possible once.
  const previous = process.env.NEXT_PUBLIC_SENTRY_DSN;
  process.env.NEXT_PUBLIC_SENTRY_DSN = "https://abc123@o1.ingest.sentry.io/42";
  const patterns = (baseSentryOptions().ignoreErrors ?? []) as Array<string | RegExp>;
  if (previous === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  else process.env.NEXT_PUBLIC_SENTRY_DSN = previous;

  const matches = (message: string) =>
    patterns.some((p) => (typeof p === "string" ? message.includes(p) : p.test(message)));

  it("drops Snapchat's SCDynimacBridge ReferenceError", () => {
    // Verbatim from the production event on /account/login, Snapchat 14.21.1.
    expect(matches("ReferenceError: Can't find variable: SCDynimacBridge")).toBe(true);
  });

  it("drops the same shape from other in-app webviews", () => {
    expect(matches("ReferenceError: Can't find variable: __fbNative")).toBe(true);
  });

  it("does NOT drop an ordinary application error", () => {
    // The filter earns its place only if it is still narrow.
    for (const real of [
      "TypeError: Cannot read properties of undefined (reading 'orderId')",
      "Error: Checkout session could not be created",
      "ReferenceError: Can't find variable: cartTotal",
    ]) {
      expect(matches(real), real).toBe(false);
    }
  });
});
