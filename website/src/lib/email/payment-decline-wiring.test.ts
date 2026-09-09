import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WEBHOOK = readFileSync(join(process.cwd(), "src/lib/payment-webhook.ts"), "utf8");

// ---------------------------------------------------------------------------
// A RECOVERY EMAIL NOBODY SENDS IS WORTH NOTHING.
//
// The rule and the sender are unit-tested; this asserts the webhook actually
// calls it, because that is the one thing those tests cannot see and the one
// thing whose absence reproduces the original leak exactly.
// ---------------------------------------------------------------------------

describe("the payment webhook sends the decline recovery", () => {
  it("calls the sender", () => {
    expect(WEBHOOK).toContain("sendPaymentDeclineRecovery");
  });

  // Guarded on payment_failed specifically. A cancellation or a refund is not a
  // decline, and the customer must not be told their card failed when it did
  // not — the sender refuses those anyway, but not reaching it also avoids a
  // pointless read on every refund the store ever processes.
  it("reaches it only on a failed payment that never settled", () => {
    expect(WEBHOOK).toMatch(/nextStatus === "payment_failed" && !wasPaid[\s\S]{0,400}sendPaymentDeclineRecovery/);
  });

  // It runs inside a webhook whose real work has already succeeded, so a throw
  // here would make the processor redeliver the whole envelope.
  it("cannot throw into the webhook", () => {
    expect(WEBHOOK).toMatch(/sendPaymentDeclineRecovery\([\s\S]{0,120}catch/);
  });
});
