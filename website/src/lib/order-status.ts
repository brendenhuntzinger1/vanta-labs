// Pure, shared order-status helpers used by the customer order UI. Maps the
// two status axes (payment_status + fulfillment_status) onto a single
// 5-step tracking progression and friendly labels/colors.

export type TrackState = "done" | "current" | "upcoming";
export interface TrackStep {
  key: string;
  label: string;
  state: TrackState;
}
export interface OrderProgress {
  cancelled: boolean;
  refunded: boolean;
  awaitingPayment: boolean;
  activeIndex: number;
  steps: TrackStep[];
  headline: string;
}

const STEP_DEFS = [
  { key: "ordered", label: "Ordered" },
  { key: "confirmed", label: "Confirmed" },
  { key: "processing", label: "Processing" },
  { key: "shipped", label: "Shipped" },
  { key: "delivered", label: "Delivered" },
] as const;

export function getOrderProgress(paymentStatus: string, fulfillmentStatus: string): OrderProgress {
  const pay = String(paymentStatus ?? "").toLowerCase();
  const ful = String(fulfillmentStatus ?? "").toLowerCase();

  // TWO COLUMNS, TWO SPELLINGS — not one column with a spelling problem.
  // Censused against production 2026-08-28 (finding F5, which asked for exactly
  // this before anyone considered a CHECK constraint):
  //
  //   payment_status      paid 7 | canceled 5 | pending_payment 5 | payment_failed 2
  //   fulfillment_status  pending 8 | cancelled 5 | awaiting_fulfillment 3
  //                       | label_purchased 2 | shipped 1
  //
  // payment_status is written with ONE l at all four write sites
  // (payment-service.ts x3, membership-billing.ts, express/authorize) and holds
  // one l in every production row. fulfillment_status uses TWO, consistently,
  // and order-pipeline.ts's ladder is spelled that way throughout.
  //
  // So `pay === "cancelled"` below is a dead branch: nothing writes it and no
  // row carries it. It is kept because it costs nothing and a two-l value
  // arriving from an import or a hand-edit should still read as cancelled —
  // but it should NOT be read as evidence that payment_status has a dual
  // spelling to be reconciled. It does not.
  const cancelled = pay === "canceled" || pay === "cancelled" || ful === "cancelled";
  const refunded = pay === "refunded" || pay === "partially_refunded";
  const paid = pay === "paid";
  const awaitingPayment = !paid && !cancelled && !refunded;

  let activeIndex = 0; // Ordered
  if (paid) activeIndex = 1; // Confirmed
  // Every state that means "we are working on it". `label_purchased` and
  // `ready_to_fulfill` are written by the Shippo sync and the fulfilment queue
  // respectively; omitting them left the tracker showing "Payment confirmed"
  // for the whole window between buying a label and the carrier's first scan —
  // a customer watching their order see no movement for a day or more.
  if (paid && ["processing", "awaiting_fulfillment", "partially_fulfilled", "ready_to_fulfill", "packed", "label_purchased"].includes(ful)) activeIndex = 2;
  // `in_transit` is what the Shippo tracking webhook writes on the carrier's
  // scans between the first pickup and the last mile (order-pipeline.ts
  // ladder). Leaving it out of this list rendered a parcel that was moving as
  // "Payment confirmed" — a production order sat in exactly that state.
  if (["shipped", "in_transit", "out_for_delivery"].includes(ful)) activeIndex = 3;
  if (["delivered", "fulfilled"].includes(ful)) activeIndex = 4;

  const steps: TrackStep[] = STEP_DEFS.map((def, i) => ({
    key: def.key,
    label: def.label,
    state: i < activeIndex ? "done" : i === activeIndex ? "current" : "upcoming",
  }));

  let headline = "Order placed";
  if (cancelled) headline = "Order cancelled";
  else if (refunded) headline = pay === "partially_refunded" ? "Partially refunded" : "Order refunded";
  else if (awaitingPayment) headline = "Awaiting payment";
  else if (activeIndex === 4) headline = "Delivered";
  else if (activeIndex === 3) headline = "On the way";
  else if (activeIndex === 2) headline = "Being prepared";
  else headline = "Payment confirmed";

  return { cancelled, refunded, awaitingPayment, activeIndex, steps, headline };
}

export function statusLabel(value: string): string {
  return String(value ?? "")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

export const UNPAID_STATUSES = ["pending", "pending_payment", "awaiting_verification", "unverified", "unpaid"];

export function isUnpaid(paymentStatus: string): boolean {
  return UNPAID_STATUSES.includes(String(paymentStatus ?? "").toLowerCase());
}

/** Statuses that record money having moved (or moved back). */
export const MONEY_STATE_PAYMENT_STATUSES = new Set(["paid", "refunded", "partially_refunded"]);

/**
 * True when a plain status write would take an order OUT of a money state.
 *
 * The admin order page refuses to move an order INTO paid/refunded through
 * its dropdown, because those transitions carry side effects. Leaving one is
 * no different: a paid order written back to pending_payment (or to a status
 * that does not exist) reverses nothing — not inventory, not commission, not
 * points or store credit — and records no history. The honest exits are the
 * refund and cancel actions.
 */
export function isPaymentStatusDemotion(current: string | null | undefined, next: string | null | undefined): boolean {
  const from = String(current ?? "").trim().toLowerCase();
  const to = String(next ?? "").trim().toLowerCase();
  if (!from || !to || from === to) return false;
  return MONEY_STATE_PAYMENT_STATUSES.has(from);
}
