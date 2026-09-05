import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveOrderCommunications,
  hasUnknowns,
  needsAttention,
  type OrderCommunicationInput,
} from "./order-communications";

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

  /**
   * Widened, deliberately, when C-02 was fixed — and inverted while widening.
   *
   * The sweep now also writes `order_email_log`, to close the send-once slot it
   * just satisfied. Without that the retry delivers the receipt, the log row
   * stays 'failed', and the next caller claims the released slot and sends the
   * customer a second one.
   *
   * `order_email_log` is email bookkeeping — the same category as
   * `pending_emails` — so this is inside the safety claim, not an exception to
   * it. But an allowlist that simply grew by one is a weaker test than it looks:
   * the next person adds a third table and the assertion grows again. So the
   * DANGEROUS set is now named explicitly, and the allowlist is kept beside it.
   */
  it("writes only to email bookkeeping, never to anything that moves money or stock", () => {
    const tables = [...new Set([...queue.matchAll(/\.from\("([a-z_]+)"\)/g)].map((match) => match[1]))];

    const FORBIDDEN = [
      "orders", "order_items", "payments", "payment_events",
      "referral_orders", "commissions", "payouts", "partner_payouts",
      "products", "product_doses", "inventory_reservations", "inventory_transactions",
      "coupons", "customer_memberships", "shippo_webhook_events",
    ];
    for (const table of tables) expect(FORBIDDEN).not.toContain(table);

    expect(tables.sort()).toEqual(["order_email_log", "pending_emails"]);
  });

  it("a manual retry does not consume the automatic retry budget", () => {
    const fn = queue.slice(queue.indexOf("export async function retryPendingEmailsForOrder"));
    // Only last_error/updated_at/status are written back — never attempts.
    expect(fn).not.toMatch(/attempts:\s*attempts/);
  });
});

describe("an unreadable queue is a monitoring gap, not a clean bill of health", () => {
  const paid = { ...base, paymentStatus: "paid", shippedAt: "2026-08-08T10:00:00Z", deliveredAt: "2026-08-09T10:00:00Z" };

  // 1. Missing pending_emails table → CANNOT DETERMINE
  it("reports CANNOT DETERMINE when the table cannot be read", () => {
    const rows = deriveOrderCommunications({ ...paid, pendingEmails: null });
    expect(rows.map((r) => r.state)).toEqual(["cannot_determine", "cannot_determine", "cannot_determine"]);
  });

  // 2. Query error → CANNOT DETERMINE (same signal, same answer)
  it("makes no distinction between a missing table and a failed query", () => {
    // Both reach the derivation as null, because both mean the same thing:
    // the answer is unknown. Anything else would need the caller to classify
    // database errors, which is not its job.
    expect(deriveOrderCommunications({ ...paid, pendingEmails: null })[0].state).toBe("cannot_determine");
  });

  // 3. Successful query, nothing found → NO FAILURE RECORDED
  it("reports NO FAILURE RECORDED when the query succeeded and found nothing", () => {
    const rows = deriveOrderCommunications({ ...paid, pendingEmails: [] });
    expect(rows.map((r) => r.state)).toEqual([
      "no_failure_recorded",
      "no_failure_recorded",
      "no_failure_recorded",
    ]);
  });

  // 4. A real failure still reads as FAILED
  it("still reports a genuine failure as FAILED", () => {
    const rows = deriveOrderCommunications({
      ...paid,
      pendingEmails: [failure("Order Confirmed - VL-1042", "failed", 5)],
    });
    expect(rows.find((r) => r.key === "confirmation")!.state).toBe("failed");
  });

  // 5. Retry states still display correctly
  it("still distinguishes retrying from recovered", () => {
    const retrying = deriveOrderCommunications({
      ...paid,
      pendingEmails: [failure("Shipping Update - VL-1042", "pending", 2)],
    });
    expect(retrying.find((r) => r.key === "shipping")!.state).toBe("retrying");

    const recovered = deriveOrderCommunications({
      ...paid,
      pendingEmails: [failure("Delivered — order VL-1042", "sent", 2)],
    });
    expect(recovered.find((r) => r.key === "delivery")!.state).toBe("recovered");
  });

  it("keeps NOT DUE trustworthy even when the queue is unreadable", () => {
    // Whether an email is due comes from the order row, which was read
    // successfully. Downgrading that to unknown would throw away a fact we have.
    const rows = deriveOrderCommunications({ ...base, pendingEmails: null });
    expect(rows.map((r) => r.state)).toEqual(["not_due", "not_due", "not_due"]);
  });

  it("never offers a retry for something it cannot see", () => {
    const rows = deriveOrderCommunications({ ...paid, pendingEmails: null });
    expect(rows.every((r) => r.retryable === false)).toBe(true);
  });

  it("does not raise a customer-impact alarm for a monitoring gap", () => {
    // needsAttention means "a customer is missing an email". Unknown is not
    // that, and folding them together would either cry wolf on every unreadable
    // query or hide a real failure among them.
    const rows = deriveOrderCommunications({ ...paid, pendingEmails: null });
    expect(needsAttention(rows)).toBe(false);
    expect(hasUnknowns(rows)).toBe(true);
  });

  it("says plainly that the data is unavailable, and claims nothing about the email", () => {
    const detail = deriveOrderCommunications({ ...paid, pendingEmails: null })[0].detail;
    expect(detail).toMatch(/Email status data unavailable/i);
    // It must not borrow the reassuring language of the clean state...
    expect(detail).not.toMatch(/\bno failure\b/i);
    // ...and it must explicitly disclaim, rather than merely omit, a verdict.
    // The word "sent" appears inside that disclaimer, which is the point —
    // matching on the word alone cannot tell a denial from a claim, so the
    // assertion is on the denial being present.
    expect(detail).toMatch(/says nothing about whether the email was sent/i);
  });
});

describe("the route distinguishes a failed read from an empty one", () => {
  const route = readFileSync(
    join(process.cwd(), "src/app/api/admin/orders/[orderId]/communications/route.ts"),
    "utf8",
  );

  it("starts from null, so an unread queue can never look empty", () => {
    expect(route).toContain("| null = null;");
  });

  it("checks Supabase's error object rather than relying on a throw", () => {
    // supabase-js reports a missing table through `error`, not an exception, so
    // a try/catch alone would silently produce an empty array.
    // Two reads now (order-linked rows, then legacy subject matches); each
    // consults its own error object, and only a genuinely failed linked read
    // is allowed to throw (a missing order_id column falls back to legacy).
    expect(route).toContain("if (linked.error && !columnMissing) throw linked.error;");
    expect(route).toContain("if (!legacy.error) {");
  });
});
