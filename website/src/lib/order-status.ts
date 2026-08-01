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

  const cancelled = pay === "canceled" || pay === "cancelled" || ful === "cancelled";
  const refunded = pay === "refunded" || pay === "partially_refunded";
  const paid = pay === "paid";
  const awaitingPayment = !paid && !cancelled && !refunded;

  let activeIndex = 0; // Ordered
  if (paid) activeIndex = 1; // Confirmed
  if (paid && ["processing", "awaiting_fulfillment", "partially_fulfilled"].includes(ful)) activeIndex = 2;
  if (["shipped", "out_for_delivery"].includes(ful)) activeIndex = 3;
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
