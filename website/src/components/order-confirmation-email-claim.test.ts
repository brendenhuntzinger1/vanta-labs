import { describe, expect, it } from "vitest";
import { EMAIL_CONFIRMATION_LEAD } from "./order-confirmation-status";

/**
 * The confirmation page renders the moment an order is paid. The confirmation
 * email is queued and sent asynchronously afterwards, and order_email_log
 * records `sending`, `sent` or `failed` — a status this page never reads.
 *
 * So the page cannot know the email arrived, and must not say that it did.
 * Browser-proven 2026-08-27: a paid order whose send failed
 * ("No email provider configured.", order_email_log.status = 'failed') still
 * rendered "a confirmation was sent to h***@…", telling the customer to wait
 * for a mail that was never coming.
 */
describe("order confirmation email claim", () => {
  it("never states the confirmation email has already been delivered", () => {
    expect(EMAIL_CONFIRMATION_LEAD).not.toMatch(/\bwas sent\b/i);
    expect(EMAIL_CONFIRMATION_LEAD).not.toMatch(/\bhas been sent\b/i);
    expect(EMAIL_CONFIRMATION_LEAD).not.toMatch(/\bwe sent\b/i);
  });

  it("still names the address so the customer can spot a typo", () => {
    // The clause is rendered as `— {LEAD} {maskedEmail}.`, so it has to read as
    // an introduction to an address rather than a standalone sentence.
    expect(EMAIL_CONFIRMATION_LEAD.trim().length).toBeGreaterThan(0);
    expect(EMAIL_CONFIRMATION_LEAD.trimEnd()).toMatch(/\bto$/i);
  });
});
