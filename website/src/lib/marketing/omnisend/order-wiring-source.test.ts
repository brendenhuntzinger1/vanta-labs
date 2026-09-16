import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WHERE THE ORDER HOOKS ARE CALLED FROM, PINNED IN THE SOURCE.
 *
 * order-hooks.ts is only useful if the store calls it at the moments an order
 * actually changes state — and calls it in a way that can never hurt the
 * caller. Four things have to be true at every call site, and none of them
 * can be proved by mocking a hook and watching it fire:
 *
 *   * `onOrderPaid` runs in BOTH paid lanes (the processor webhook's paid
 *     side-effects block and the manual-approval lane), AFTER the row is
 *     marked paid, and on NO failure path: a declined, expired, cancelled,
 *     fraud-held or refunded payment must not produce a success event that
 *     would drop a contact into the post-purchase flow;
 *   * every call is deferred past the response (after(), or the module's own
 *     deferral that wraps it), so a slow or failing Omnisend request can never
 *     delay a webhook acknowledgement or fail an admin action;
 *   * the fulfilment event is fired from the shipping notification path, the
 *     cancel event from the one writer every admin cancel goes through, and
 *     the refund event only for a FULL refund — a partial refund fires nothing;
 *   * nothing here calls the transport directly: only order-hooks.ts decides
 *     what an order event looks like and whether it has already been sent.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** Source with comments removed: documenting a rule is not applying it. */
function executable(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

const WEBHOOK = executable(read("src/lib/payment-webhook.ts"));
const SERVICE = executable(read("src/lib/shippo/service.ts"));
const ADMIN_ROUTE = executable(read("src/app/api/admin/orders/[orderId]/route.ts"));
const BULK = executable(read("src/lib/admin-orders.ts"));
const DEFER = executable(read("src/lib/marketing/omnisend/defer.ts"));

/** A top-level function body, from its declaration to the first unindented close. */
function fn(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `${declaration} not found`).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}\n");
  return rest.slice(0, end > 0 ? end : undefined);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const PAID_CALL = 'deferOmnisend("orders", () => onOrderPaid(orderId))';

describe("the deferral every lib call site uses", () => {
  it("wraps next/server after() and never lets the deferred work throw", () => {
    expect(DEFER).toMatch(/import \{ after \} from "next\/server";/);
    expect(DEFER).toContain("after(guarded)");
    // The guard: the work is inside try/catch and logs under the module prefix.
    expect(DEFER).toMatch(/try \{\s*await run\(\);\s*\} catch \(error\) \{\s*console\.error\(`\[omnisend\/\$\{label\}\]/);
    // No request scope (a sweep, a script, a test): fall back rather than
    // throw into a caller that is in the middle of confirming a payment.
    expect(DEFER).toMatch(/try \{\s*after\(guarded\);\s*\} catch \{\s*void guarded\(\);/);
  });
});

describe("payment-webhook.ts reports a paid order from both lanes and from nowhere else", () => {
  it("imports the hook and the deferral", () => {
    expect(WEBHOOK).toMatch(/import \{ onOrderPaid \} from "@\/lib\/marketing\/omnisend\/order-hooks";/);
    expect(WEBHOOK).toMatch(/import \{ deferOmnisend \} from "@\/lib\/marketing\/omnisend\/defer";/);
  });

  it("calls onOrderPaid exactly twice — once per paid lane — and always deferred", () => {
    expect(count(WEBHOOK, "onOrderPaid(")).toBe(2);
    expect(count(WEBHOOK, PAID_CALL)).toBe(2);
  });

  describe("the manual-approval lane", () => {
    const lane = fn(WEBHOOK, "export async function finalizeManualPayment(");

    it("fires after the row is marked paid and after the single-use claim is won", () => {
      const paidWrite = lane.indexOf('payment_status: "paid",');
      // The claim's losing return: a second approval matches zero rows and
      // returns here, before anything below can fire.
      const claimLost = lane.indexOf("if (!claimed || claimed.length === 0) {");
      const hook = lane.indexOf(PAID_CALL);
      expect(paidWrite).toBeGreaterThan(-1);
      expect(claimLost).toBeGreaterThan(paidWrite);
      expect(lane.slice(claimLost, claimLost + 120)).toContain("alreadyPaid: true");
      expect(hook).toBeGreaterThan(claimLost);
      // Only once in this lane.
      expect(count(lane, "onOrderPaid(")).toBe(1);
    });

    it("fires after the cart-recovery mark, which is the same paid moment", () => {
      const recovered = lane.indexOf("await markAbandonedCartsRecovered(");
      expect(recovered).toBeGreaterThan(-1);
      expect(lane.indexOf(PAID_CALL)).toBeGreaterThan(recovered);
    });
  });

  describe("the processor-webhook lane", () => {
    const lane = fn(WEBHOOK, "export async function processPaymentWebhook(");
    const paidBranch = lane.indexOf('if (nextStatus === "paid") {\n');
    const refundBranch = lane.indexOf(
      'if (nextStatus === "refunded" || nextStatus === "canceled" || nextStatus === "payment_failed") {',
    );

    it("has the paid branch before the reversal branch, so the slices below mean what they say", () => {
      expect(paidBranch).toBeGreaterThan(-1);
      expect(refundBranch).toBeGreaterThan(paidBranch);
    });

    it("fires inside the paid side-effects claim, after the claim is taken", () => {
      const paid = lane.slice(paidBranch, refundBranch);
      const claim = paid.indexOf("paid_side_effects_at: new Date().toISOString()");
      const runSideEffects = paid.indexOf("if (runSideEffects) {");
      const hook = paid.indexOf(PAID_CALL);
      expect(claim).toBeGreaterThan(-1);
      expect(runSideEffects).toBeGreaterThan(claim);
      expect(hook).toBeGreaterThan(runSideEffects);
      expect(count(paid, "onOrderPaid(")).toBe(1);
    });

    it("fires after the cart-recovery mark and beside the Shippo deferral", () => {
      const paid = lane.slice(paidBranch, refundBranch);
      const recovered = paid.indexOf("await markAbandonedCartsRecovered(");
      const shippo = paid.indexOf("scheduleShippoSync(orderId);");
      const hook = paid.indexOf(PAID_CALL);
      expect(recovered).toBeGreaterThan(-1);
      expect(shippo).toBeGreaterThan(-1);
      expect(hook).toBeGreaterThan(recovered);
      expect(Math.abs(hook - shippo)).toBeLessThan(600);
    });

    it("never fires on a refund, cancel or failed payment", () => {
      const reversal = lane.slice(refundBranch);
      expect(reversal).not.toContain("onOrderPaid(");
      expect(reversal).not.toContain("deferOmnisend(");
    });

    it("never fires before the paid branch: every ordering guard, the lost-race return and the row upsert come first", () => {
      const before = lane.slice(0, paidBranch);
      expect(before).not.toContain("onOrderPaid(");
      expect(before).not.toContain("deferOmnisend(");
    });
  });

  it("is not referenced by the row writer, the refund resolver or the commission reversal", () => {
    for (const declaration of [
      "async function upsertOrderRecord(",
      "export function resolveRefundOutcome(",
      "export async function updateCommissionOnRefund(",
    ]) {
      expect(fn(WEBHOOK, declaration)).not.toContain("onOrderPaid");
    }
  });
});

describe("shippo/service.ts fires fulfilment from the shipping notification and cancel from the one writer", () => {
  it("imports the two hooks and the deferral", () => {
    expect(SERVICE).toMatch(/import \{ onOrderCancelled, onOrderFulfilled \} from "@\/lib\/marketing\/omnisend\/order-hooks";/);
    expect(SERVICE).toMatch(/import \{ deferOmnisend \} from "@\/lib\/marketing\/omnisend\/defer";/);
  });

  it("notifyCustomer fires onOrderFulfilled once a notice is due, deferred, after the address and kind resolve", () => {
    const notify = fn(SERVICE, "async function notifyCustomer(");
    const kind = notify.indexOf("const kind = notificationFor(from, next);");
    const guard = notify.indexOf("if (!to || !kind) return false;");
    const hook = notify.indexOf('deferOmnisend("orders", () => onOrderFulfilled(order.order_id));');
    expect(kind).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(kind);
    expect(hook).toBeGreaterThan(guard);
    expect(count(notify, "onOrderFulfilled(")).toBe(1);
  });

  it("setOrderFulfillmentStatus fires onOrderCancelled after the guarded write is won, and the same fulfilment rule for a hand-marked shipment", () => {
    const writer = fn(SERVICE, "export async function setOrderFulfillmentStatus(");
    const won = writer.indexOf("if (!write.won) {");
    const history = writer.indexOf("await recordStatusHistory(transition.history);");
    const cancel = writer.indexOf('deferOmnisend("orders", () => onOrderCancelled(order.order_id));');
    const fulfilled = writer.indexOf('deferOmnisend("orders", () => onOrderFulfilled(order.order_id));');
    expect(won).toBeGreaterThan(-1);
    expect(history).toBeGreaterThan(won);
    expect(cancel).toBeGreaterThan(history);
    expect(fulfilled).toBeGreaterThan(history);
    // Cancel only on the cancel transition; fulfilment by the same rule the
    // email uses, so a hand-marked "shipped" reports exactly when it notifies.
    expect(writer).toMatch(/if \(transition\.next === "cancelled"\) \{\s*deferOmnisend\("orders", \(\) => onOrderCancelled/);
    expect(writer).toMatch(/else if \(notificationFor\(transition\.from, transition\.next\)\) \{\s*deferOmnisend\("orders", \(\) => onOrderFulfilled/);
  });

  it("the writer is the only cancel path: every admin cancel goes through it", () => {
    const cancelAction = ADMIN_ROUTE.slice(ADMIN_ROUTE.indexOf('if (action === "cancel" || action === "resend_confirmation") {'));
    expect(cancelAction).toMatch(/await setOrderFulfillmentStatus\(\{\s*orderId,\s*to: "cancelled",/);
    const bulk = fn(BULK, "export async function bulkUpdateAdminOrders(");
    expect(bulk).toContain('nextStatus = "cancelled";');
    expect(bulk).toContain("await setOrderFulfillmentStatus({");
    // Neither caller re-fires the event itself; the writer does, once.
    expect(ADMIN_ROUTE).not.toContain("onOrderCancelled");
    expect(BULK).not.toContain("onOrderCancelled");
  });
});

describe("the admin refund action reports a FULL refund only", () => {
  const refund = ADMIN_ROUTE.slice(
    ADMIN_ROUTE.indexOf('if (action === "refund") {'),
    ADMIN_ROUTE.indexOf('if (action === "send_replacement") {'),
  );

  it("imports the hook and after()", () => {
    expect(ADMIN_ROUTE).toMatch(/import \{ onOrderRefunded \} from "@\/lib\/marketing\/omnisend\/order-hooks";/);
    expect(ADMIN_ROUTE).toMatch(/import \{ NextResponse, after \} from "next\/server";/);
  });

  it("fires inside after(), only under isFullRefund, after the compare-and-set claim is won", () => {
    const claimWon = refund.indexOf("if (!claimed || claimed.length === 0) {");
    const commission = refund.indexOf("await updateCommissionOnRefund(orderId, { refundedFraction });");
    const hook = refund.indexOf("after(() => onOrderRefunded(orderId));");
    expect(claimWon).toBeGreaterThan(-1);
    expect(commission).toBeGreaterThan(claimWon);
    expect(hook).toBeGreaterThan(commission);
    expect(count(refund, "onOrderRefunded(")).toBe(1);
    // The guard: a partial refund keeps `partially_refunded` and fires nothing.
    expect(refund).toMatch(/if \(isFullRefund\) \{\s*after\(\(\) => onOrderRefunded\(orderId\)\);/);
    expect(refund).toContain('payment_status: isFullRefund ? "refunded" : "partially_refunded",');
  });

  it("is the only place the route fires it", () => {
    expect(count(ADMIN_ROUTE, "onOrderRefunded(")).toBe(1);
  });
});

describe("no call site talks to Omnisend directly", () => {
  it("only order-hooks.ts sends order events", () => {
    for (const [name, source] of [["payment-webhook", WEBHOOK], ["shippo/service", SERVICE], ["admin route", ADMIN_ROUTE], ["admin-orders", BULK]] as const) {
      expect(source, name).not.toContain("sendOmnisendEvent");
      expect(source, name).not.toContain("omnisendRequest");
      expect(source, name).not.toContain("buildOrderEvent");
    }
  });
});
