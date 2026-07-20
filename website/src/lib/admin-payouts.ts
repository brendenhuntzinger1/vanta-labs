import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getFulfillmentRuntimeConfig } from "@/lib/fulfillment/config";
import { computePayoutOwed } from "@/lib/fulfillment/service";

// Estimated card-processor cost (your cost, not what the customer is charged),
// used to show "payment processor fees" in the P&L. Card orders only; manual
// methods (Cash App / Zelle / PayPal) carry no processor fee here.
const EST_CARD_FEE_RATE = 0.029;
const EST_CARD_FEE_FIXED = 0.3;

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

export interface PayoutRow {
  order_id: string;
  order_number: string;
  customer_name: string | null;
  payment_method: string;
  units: number;
  gross: number;
  shippingCollected: number;
  taxesFeesCollected: number;
  processorFees: number;
  netRevenue: number;
  threeplOwed: number;
  profit: number;
  payoutStatus: string; // pending | paid | failed
  created_at: string;
}

export interface PayoutSummary {
  orders: number;
  totalGross: number;
  totalNetRevenue: number;
  total3plOwed: number;
  totalProfit: number;
  pendingPayoutTotal: number;
  paidPayoutTotal: number;
  payoutModel: string;
  payoutRate: number;
}

export interface PayoutDashboard {
  summary: PayoutSummary;
  rows: PayoutRow[];
}

interface OrderQueryRow {
  order_id: string;
  order_number: string | null;
  customer_name: string | null;
  payment_method: string | null;
  amount_paid: number | null;
  shipping_amount: number | null;
  tax_amount: number | null;
  handling_fee: number | null;
  card_processing_fee: number | null;
  created_at: string;
  order_items?: Array<{ quantity?: number | null }>;
}

export async function getPayoutDashboard(): Promise<PayoutDashboard> {
  const config = await getFulfillmentRuntimeConfig();

  const [ordersResult, payoutsResult] = await Promise.all([
    supabaseAdmin
      .from("orders")
      .select("order_id, order_number, customer_name, payment_method, amount_paid, shipping_amount, tax_amount, handling_fee, card_processing_fee, created_at, order_items(quantity)")
      .eq("payment_status", "paid")
      .order("created_at", { ascending: false })
      .limit(5000),
    supabaseAdmin.from("fulfillment_payouts").select("order_id, status"),
  ]);

  if (ordersResult.error) throw ordersResult.error;

  const statusByOrder = new Map<string, string>();
  for (const row of payoutsResult.data ?? []) {
    statusByOrder.set(String(row.order_id), String(row.status ?? "pending"));
  }

  const orders = (ordersResult.data ?? []) as OrderQueryRow[];

  let totalGross = 0;
  let totalNetRevenue = 0;
  let total3plOwed = 0;
  let totalProfit = 0;
  let pendingPayoutTotal = 0;
  let paidPayoutTotal = 0;

  const rows: PayoutRow[] = orders.map((order) => {
    const gross = roundMoney(Number(order.amount_paid ?? 0));
    const shippingCollected = roundMoney(Number(order.shipping_amount ?? 0));
    const taxesFeesCollected = roundMoney(
      Number(order.tax_amount ?? 0) + Number(order.handling_fee ?? 0) + Number(order.card_processing_fee ?? 0),
    );
    const units = (order.order_items ?? []).reduce((sum, item) => sum + Number(item.quantity ?? 0), 0);
    const isCard = String(order.payment_method ?? "") === "card";
    const processorFees = isCard && gross > 0 ? roundMoney(gross * EST_CARD_FEE_RATE + EST_CARD_FEE_FIXED) : 0;
    const netRevenue = roundMoney(gross - processorFees);
    const threeplOwed = computePayoutOwed(config, { amountPaid: gross, units });
    const profit = roundMoney(netRevenue - threeplOwed);
    const payoutStatus = statusByOrder.get(order.order_id) ?? "pending";

    totalGross += gross;
    totalNetRevenue += netRevenue;
    total3plOwed += threeplOwed;
    totalProfit += profit;
    if (payoutStatus === "paid") paidPayoutTotal += threeplOwed;
    else pendingPayoutTotal += threeplOwed;

    return {
      order_id: order.order_id,
      order_number: order.order_number ?? order.order_id,
      customer_name: order.customer_name,
      payment_method: String(order.payment_method ?? ""),
      units,
      gross,
      shippingCollected,
      taxesFeesCollected,
      processorFees,
      netRevenue,
      threeplOwed,
      profit,
      payoutStatus,
      created_at: order.created_at,
    };
  });

  return {
    summary: {
      orders: rows.length,
      totalGross: roundMoney(totalGross),
      totalNetRevenue: roundMoney(totalNetRevenue),
      total3plOwed: roundMoney(total3plOwed),
      totalProfit: roundMoney(totalProfit),
      pendingPayoutTotal: roundMoney(pendingPayoutTotal),
      paidPayoutTotal: roundMoney(paidPayoutTotal),
      payoutModel: config.payoutModel,
      payoutRate: config.payoutRate,
    },
    rows,
  };
}

// Sets the payout status for an order (upsert into fulfillment_payouts).
export async function setPayoutStatus(orderId: string, status: "pending" | "paid" | "failed", reference?: string) {
  const now = new Date().toISOString();
  const { data: existing } = await supabaseAdmin
    .from("fulfillment_payouts")
    .select("id")
    .eq("order_id", orderId)
    .maybeSingle();

  if (existing) {
    await supabaseAdmin
      .from("fulfillment_payouts")
      .update({ status, reference: reference ?? null, paid_at: status === "paid" ? now : null, updated_at: now })
      .eq("order_id", orderId);
    return;
  }

  // No payout row yet (e.g. fulfillment was disabled when the order paid) —
  // create one from the current config so status can be tracked.
  const config = await getFulfillmentRuntimeConfig();
  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("order_number, amount_paid, payment_method, order_items(quantity)")
    .eq("order_id", orderId)
    .maybeSingle();

  const units = ((order?.order_items ?? []) as Array<{ quantity?: number | null }>).reduce((sum, item) => sum + Number(item.quantity ?? 0), 0);
  const amountOwed = computePayoutOwed(config, { amountPaid: Number(order?.amount_paid ?? 0), units });

  await supabaseAdmin.from("fulfillment_payouts").insert({
    order_id: orderId,
    order_number: order?.order_number ?? orderId,
    provider: config.providerName,
    units,
    model: config.payoutModel,
    rate: config.payoutRate,
    amount_owed: amountOwed,
    status,
    reference: reference ?? null,
    paid_at: status === "paid" ? now : null,
    created_at: now,
    updated_at: now,
  });
}
