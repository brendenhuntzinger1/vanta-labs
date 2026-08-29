import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// A RECOVERY LINK MUST NEVER GO ON THE RETRY QUEUE.
//
// Every other transactional email in this app queues on failure, and the sweep
// redelivers it minutes later. Doing the same here is wrong, and wrong in a way
// that looks right: `auth.users.recovery_token` is a SINGLE column, so the next
// recovery request for that user overwrites the token embedded in the link we
// already built. This route's own Supabase fallback issues exactly such a
// request on the failure path.
//
// Queue it and the sequence is: the provider fails → we queue link A → the
// fallback mints token B and mails a working link → minutes later the sweep
// delivers link A, whose token no longer exists. The customer gets two password
// reset emails for one request and the second one is dead.
//
// The first version of this route did precisely that. The test exists because
// "transactional email that failed should be retried" is a rule the rest of the
// codebase follows correctly, and someone will reasonably try to apply it here.
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(
  join(process.cwd(), "src/app/api/auth/password-reset/route.ts"),
  "utf8",
);

describe("password-reset delivery", () => {
  it("does not enqueue the recovery email for retry", () => {
    expect(SOURCE).not.toContain("enqueueFailedEmail");
    expect(SOURCE).not.toContain("@/lib/email/retry-queue");
  });

  it("still makes a provider failure visible", () => {
    // Not queuing must not mean not noticing: the operator has to learn that
    // their provider refused a reset and that recovery is running on the
    // fallback, where the bounce webhook cannot see it.
    expect(SOURCE).toContain("recordSystemAlert");
    expect(SOURCE).toContain("password_reset_provider_failed");
  });

  it("falls back to Supabase so the customer is not left waiting", () => {
    expect(SOURCE).toContain("resetPasswordForEmail");
  });

  it("mints the link with the admin API and sends it through sendEmail", () => {
    // The whole point of the route: generateLink produces a link WITHOUT
    // sending, so the send is ours and inherits the provider and bounce webhook.
    expect(SOURCE).toContain("generateLink");
    expect(SOURCE).toContain('type: "recovery"');
    expect(SOURCE).toContain("passwordResetTemplate");
    expect(SOURCE).toContain("await sendEmail(");
  });

  it("answers identically whether or not the address has an account", () => {
    // generateLink reports "user not found". If that ever reaches the client
    // this endpoint becomes the account oracle the signup form avoids being.
    expect(SOURCE).toContain("GENERIC_RESPONSE");
    // Every return in POST hands back the same object, except the two explicit
    // refusals (rate limit, captcha) which say nothing about the address.
    const post = SOURCE.slice(SOURCE.indexOf("export async function POST"), SOURCE.indexOf("async function deliverResetEmail"));
    const jsonReturns = post.match(/NextResponse\.json\(/g) ?? [];
    const genericReturns = post.match(/NextResponse\.json\(GENERIC_RESPONSE\)/g) ?? [];
    expect(jsonReturns.length - genericReturns.length).toBe(2);
  });

  it("rate limits by address as well as by IP", () => {
    expect(SOURCE).toContain("password-reset-ip");
    expect(SOURCE).toContain("password-reset-email:");
  });

  it("verifies the captcha server-side rather than forwarding it", () => {
    expect(SOURCE).toContain("verifyTurnstileToken");
  });
});
