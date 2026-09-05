import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// A CANCEL BEFORE ANY CAPTURE IS NOT A REFUND.
//
// payment.canceled (and an admin cancel of an unpaid order) writes
// payment_status = 'canceled' with no money moved. The webhook then treated
// that word as a money-terminal state: a later payment.succeeded — a retry on
// the same session, a hosted page that outlived the cancel — was recorded
// against the canceled status and dropped. Money captured, order canceled,
// nobody told. The guard now distinguishes a never-captured cancel (no paid_at,
// no refund) and lets the success reopen the order as paid, with an alert.
//
// Source-level: the webhook's paid path needs a live fake of the whole order
// pipeline; the harness drives the real sequence (cancel event, then success
// event) and is where the behaviour is exercised end to end.
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(join(process.cwd(), "src/lib/payment-webhook.ts"), "utf8");

describe("payment.succeeded after a never-captured cancel", () => {
  it("only short-circuits a terminal state that actually moved money", () => {
    const guard = SOURCE.indexOf('const REFUND_TERMINAL_STATES = new Set(["refunded", "partially_refunded", "canceled"]);');
    expect(guard).toBeGreaterThan(0);
    const window = SOURCE.slice(guard, guard + 2200);
    expect(window).toContain('priorPaymentStatus === "canceled"');
    expect(window).toContain("!orderRecord?.paid_at");
    expect(window).toContain("Number(orderRecord?.refund_amount ?? 0) <= 0");
    expect(window).toContain("REFUND_TERMINAL_STATES.has(priorPaymentStatus) && !neverCaptured");
  });

  it("tells the operator the order was reopened rather than reopening it silently", () => {
    expect(SOURCE).toContain('type: "payment_captured_after_cancel"');
    const alert = SOURCE.indexOf('type: "payment_captured_after_cancel"');
    expect(SOURCE.slice(alert, alert + 700)).toContain("reopened as paid");
  });

  it("a refunded order is still terminal for a late success", () => {
    // neverCaptured is scoped to "canceled": refunded / partially_refunded keep
    // the original short-circuit, so a replayed success cannot re-award a
    // refunded order's commission, points or receipt.
    const guard = SOURCE.indexOf("const neverCaptured = ");
    expect(SOURCE.slice(guard, guard + 200)).toMatch(/priorPaymentStatus === "canceled"\s*&&/);
  });
});

describe("a degraded finalize releases the holds the fallback replaced", () => {
  it("drops this order's active holds after the direct decrement so reserved_quantity stops double-counting", () => {
    const fallback = SOURCE.indexOf("const decrement = await decrementInventoryForOrder(unmoved, orderId);");
    expect(fallback).toBeGreaterThan(0);
    const window = SOURCE.slice(fallback, fallback + 1500);
    expect(window).toContain("if (fin.degraded) {");
    expect(window).toContain("await releaseInventoryForOrder(orderId).catch(() => {});");
  });
});
