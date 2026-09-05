import "server-only";

import { orderConfirmationTemplate, refundConfirmationTemplate } from "@/lib/email/templates";
import type { EmailTemplate } from "@/lib/email/types";
import { getSiteUrl } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * Render an order's transactional emails FROM THE ORDER ROW, after the fact.
 *
 * The payment webhook renders the confirmation from the event it is holding;
 * the admin "resend confirmation" action and the stranded-send reaper have no
 * event, only the order as stored. Both need the same rendering, from the same
 * columns, so a resend and a re-queued stranded receipt say what the original
 * would have said. One place, so the two cannot drift.
 */

export interface OrderEmailItemRow {
  product_name?: string | null;
  product_id?: string | null;
  quantity?: number | null;
  line_total?: number | null;
}

export interface OrderEmailSourceRow {
  order_id?: string | null;
  order_number?: string | null;
  customer_email?: string | null;
  customer_name?: string | null;
  subtotal?: number | null;
  shipping_amount?: number | null;
  discount_amount?: number | null;
  tax_amount?: number | null;
  card_processing_fee?: number | null;
  amount_paid?: number | null;
  payment_status?: string | null;
  order_items?: OrderEmailItemRow[] | null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The receipt, exactly as the admin resend has always rendered it. */
export function renderOrderConfirmationFromRecord(order: OrderEmailSourceRow, orderId: string): EmailTemplate {
  const orderItems = order.order_items ?? [];
  return orderConfirmationTemplate({
    customerName: String(order.customer_name ?? ""),
    orderId: order.order_number ? String(order.order_number) : orderId,
    items: orderItems.map((item) => ({
      name: item.product_name ?? item.product_id ?? "Item",
      quantity: Number(item.quantity ?? 0),
      lineTotal: roundMoney(Number(item.line_total ?? 0)),
    })),
    subtotal: roundMoney(Number(order.subtotal ?? 0)),
    shipping: roundMoney(Number(order.shipping_amount ?? 0)),
    discount: roundMoney(Number(order.discount_amount ?? 0)),
    tax: roundMoney(Number(order.tax_amount ?? 0)),
    cardProcessingFee: roundMoney(Number(order.card_processing_fee ?? 0)),
    total: roundMoney(Number(order.amount_paid ?? 0)),
    orderUrl: `${getSiteUrl()}/order-confirmation/${orderId}`,
  });
}

/**
 * A refund notice for the CUMULATIVE amount a `refund_confirmation:<cents>`
 * send-once slot names. The webhook records a full reversal as exactly the
 * amount paid (see resolveRefundOutcome), so "full" is the same comparison
 * here that produced the kind in the first place.
 */
export function renderRefundConfirmationFromRecord(
  order: OrderEmailSourceRow,
  orderId: string,
  refundCents: number,
): EmailTemplate {
  const paidCents = Math.round(Number(order.amount_paid ?? 0) * 100);
  return refundConfirmationTemplate({
    customerName: String(order.customer_name ?? ""),
    orderId: order.order_number ? String(order.order_number) : orderId,
    refundAmount: roundMoney(refundCents / 100),
    isFullRefund: paidCents > 0 && refundCents >= paidCents,
  });
}

/** The order with its line items, or null when it cannot be read. Never throws. */
export async function loadOrderForEmail(orderId: string): Promise<OrderEmailSourceRow | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("*, order_items(*)")
      .eq("order_id", orderId)
      .maybeSingle();
    if (error || !data) return null;
    return data as OrderEmailSourceRow;
  } catch {
    return null;
  }
}
