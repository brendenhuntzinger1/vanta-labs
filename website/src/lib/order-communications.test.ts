import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveOrderCommunications, needsAttention, type OrderCommunicationInput } from "./order-communications";

const base: OrderCommunicationInput = {
  orderNumber: "VL-1042",
  paymentStatus: "pending_payment",
  fulfillmentStatus: "pending",
  shippedAt: null,
  deliveredAt: null,
  pendingEmails: [],
};

const row = (input: OrderCommunicationInput, key: "confirmation" | "shipping" | "delivery") =>
  deriveOrderCommunications(input).find((r) => r.key === key)!;

const failure = (subject: string, status: string, attempts = 3, error = "provider timeout") => ({
  id: `${subject}-${status}`,
  subject,
  status,
  attempts,
  last_error: error,
  updated_at: "2026-08-09T12:00:00Z",
});

describe("when each email becomes due", () => {
  it("holds the confirmation until the order is actually paid", () => {
    expect(row(base, "confirmation").state).toBe("not_due");
    expect(row({ ...base, paymentStatus: "paid" }, "confirmation").state).toBe("no_failure_recorded");
  });

  it("holds the shipping email until a carrier scan, not a printed label", () => {
    const labelled = { ...base, paymentStatus: "paid", fulfillmentStatus: "label_purchased" };
    expect(row(labelled, "shipping").state).toBe("not_due");
    expect(row(labelled, "shipping").detail).toMatch(/printed label does not send this/i);
  });

  it("treats the shipping email as due from the first scan onward", () => {
    for (const status of ["shipped", "in_transit", "out_for_delivery", "delivered"]) {
      expect(row({ ...base, paymentStatus: "paid", fulfillmentStatus: status }, "shipping").state).toBe(
        "no_failure_recorded",
      );
    }
  });

  it("keeps the shipping email due once shipped_at is stamped, even as status moves on", () => {
    // shipped_at is set on the first movement and never moved, so it survives
    // the parcel progressing past "shipped".
    const later = { ...base, paymentStatus: "paid", fulfillmentStatus: "out_for_delivery", shippedAt: "2026-08-08T10:00:00Z" };
    expect(row(later, "shipping").state).toBe("no_failure_recorded");
  });

  it("holds the delivery email until delivery is reported", () => {
    expect(row({ ...base, fulfillmentStatus: "in_transit" }, "delivery").state).toBe("not_due");
    expect(row({ ...base, deliveredAt: "2026-08-09T10:00:00Z" }, "delivery").state).toBe("no_failure_recorded");
  });
});

describe("failures are impossible to miss", () => {
  const paid = { ...base, paymentStatus: "paid" };

  it("shows a paid order whose confirmation failed as FAILED, not fine", () => {
    const input = { ...paid, pendingEmails: [failure("Order Confirmed - VL-1042", "failed", 5)] };
    const confirmation = row(input, "confirmation");
    expect(confirmation.state).toBe("failed");
    expect(confirmation.detail).toMatch(/did not receive/i);
    expect(confirmation.lastError).toBe("provider timeout");
    expect(needsAttention(deriveOrderCommunications(input))).toBe(true);
  });

  it("distinguishes still-retrying from given-up", () => {
    const retrying = { ...paid, pendingEmails: [failure("Order Confirmed - VL-1042", "pending", 2)] };
    expect(row(retrying, "confirmation").state).toBe("retrying");
    expect(needsAttention(deriveOrderCommunications(retrying))).toBe(true);
  });

  it("shows a failure that later succeeded as recovered, not clean", () => {
    const recovered = { ...paid, pendingEmails: [failure("Order Confirmed - VL-1042", "sent", 2)] };
    expect(row(recovered, "confirmation").state).toBe("recovered");
    expect(needsAttention(deriveOrderCommunications(recovered))).toBe(false);
  });

  it("surfaces the worst outcome when one email failed and a duplicate succeeded", () => {
    const mixed = {
      ...paid,
      pendingEmails: [failure("Order Confirmed - VL-1042", "sent", 1), failure("Order Confirmed - VL-1042", "failed", 5)],
    };
    expect(row(mixed, "confirmation").state).toBe("failed");
  });
});

describe("matching a failure to its order and its kind", () => {
  const paid = { ...base, paymentStatus: "paid", shippedAt: "2026-08-08T10:00:00Z", deliveredAt: "2026-08-09T10:00:00Z" };

  it("routes each subject to the right row", () => {
    const input = {
      ...paid,
      pendingEmails: [
        failure("Order Confirmed - VL-1042", "failed"),
        failure("Shipping Update - VL-1042", "pending"),
        failure("Delivered — order VL-1042", "sent"),
      ],
    };
    expect(row(input, "confirmation").state).toBe("failed");
    expect(row(input, "shipping").state).toBe("retrying");
    expect(row(input, "delivery").state).toBe("recovered");
  });

  it("never attributes another order's failure to this one", () => {
    const input = { ...paid, pendingEmails: [failure("Order Confirmed - VL-9999", "failed")] };
    expect(row(input, "confirmation").state).toBe("no_failure_recorded");
  });

  it("does not let a refund failure masquerade as a confirmation failure", () => {
    const input = { ...paid, pendingEmails: [failure("Refund processed - VL-1042", "failed")] };
    expect(row(input, "confirmation").state).toBe("no_failure_recorded");
  });
});

describe("the panel never claims more than the data supports", () => {
  it("says no failure was recorded rather than 'sent'", () => {
    // Nothing writes a row on success, so a clean row is the absence of a
    // failure — not evidence of delivery. Saying "Sent" would be a guess.
    const clean = row({ ...base, paymentStatus: "paid" }, "confirmation");
    expect(clean.state).toBe("no_failure_recorded");
    expect(clean.detail).not.toMatch(/\bsent\b/i);
  });

  it("offers a retry only where there is something queued to retry", () => {
    expect(row({ ...base, paymentStatus: "paid" }, "confirmation").retryable).toBe(false);
    const failed = { ...base, paymentStatus: "paid", pendingEmails: [failure("Order Confirmed - VL-1042", "failed")] };
    expect(row(failed, "confirmation").retryable).toBe(true);
  });
});

describe("retrying an email cannot touch business logic", () => {
  // The safety claim made to the owner in the UI, asserted rather than trusted.
  const queue = readFileSync(join(process.cwd(), "src/lib/email/retry-queue.ts"), "utf8");

  it("the retry module imports nothing that can move money, stock or status", () => {
    const imports = queue.match(/^import .*$/gm) ?? [];
    for (const line of imports) {
      expect(line).not.toMatch(/payment|inventory|commission|fulfil|shippo|quote-order|order-status/i);
    }
  });

  it("it only ever writes to its own queue table", () => {
    const tables = [...queue.matchAll(/\.from\("([a-z_]+)"\)/g)].map((match) => match[1]);
    expect([...new Set(tables)]).toEqual(["pending_emails"]);
  });

  it("a manual retry does not consume the automatic retry budget", () => {
    const fn = queue.slice(queue.indexOf("export async function retryPendingEmailsForOrder"));
    // Only last_error/updated_at/status are written back — never attempts.
    expect(fn).not.toMatch(/attempts:\s*attempts/);
  });
});
