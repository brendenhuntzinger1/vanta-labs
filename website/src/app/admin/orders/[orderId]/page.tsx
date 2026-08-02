import { notFound, redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageRefunds, canViewProfit } from "@/lib/admin-roles";
import { supabaseAdmin } from "@/lib/supabase-server";
import { AdminOrderActions } from "@/components/admin-order-actions";
import { AdminOrderTimeline } from "@/components/admin-order-timeline";
import { AdminOrderProfitPanel } from "@/components/admin-order-profit-panel";
import { getOrderProfit, getShippingCostAudit } from "@/lib/admin-profit";

export const dynamic = "force-dynamic";

function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export default async function AdminOrderDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const session = await verifyAdminSessionFromCookie();

  if (!session) {
    redirect("/vault");
  }

  const [{ data, error }, { data: auditRows }, { data: shipment }] = await Promise.all([
    supabaseAdmin
      .from("orders")
      .select("*, order_items(*)")
      .eq("order_id", orderId)
      .maybeSingle(),
    supabaseAdmin
      .from("admin_audit_logs")
      .select("id, action, metadata, created_at")
      .eq("target_table", "orders")
      .eq("target_id", orderId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabaseAdmin
      .from("order_shipments")
      .select("carrier, estimated_delivery")
      .eq("order_id", orderId)
      .maybeSingle(),
  ]);

  if (error || !data) {
    notFound();
  }

  // COGS/margin is manager+ only — the lowest-privilege staff role must not see
  // internal per-order profit. (The panel below already renders only when non-null.)
  const canSeeProfit = canViewProfit(session.role);
  const [profit, shippingAudit] = canSeeProfit
    ? await Promise.all([
        getOrderProfit(orderId).catch(() => null),
        getShippingCostAudit(orderId).catch(() => []),
      ])
    : [null, []];

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="vl-panel mx-auto max-w-5xl rounded-2xl p-4 sm:p-8">
        <h1 className="break-all text-2xl font-semibold sm:text-3xl">{data.order_id}</h1>
        <p className="mt-2 text-sm text-zinc-400">Customer: {data.customer_email}</p>

        <AdminOrderActions
          orderId={String(data.order_id)}
          initialPaymentStatus={String(data.payment_status ?? "pending_payment")}
          initialFulfillmentStatus={String(data.fulfillment_status ?? "pending")}
          initialTrackingNumber={data.tracking_number ? String(data.tracking_number) : null}
          amountPaid={Number(data.amount_paid ?? 0)}
          refundAmount={Number(data.refund_amount ?? 0)}
          canRefund={canManageRefunds(session.role)}
          initialCarrier={shipment?.carrier ?? null}
          initialEstimatedDelivery={shipment?.estimated_delivery ?? null}
          orderItems={((data.order_items ?? []) as Array<{ id: string | number; product_name?: string | null; product_id?: string | null; quantity?: number | null }>).map((item) => ({
            id: String(item.id),
            name: String(item.product_name ?? item.product_id ?? "Item"),
            quantity: Math.max(1, Number(item.quantity ?? 1)),
          }))}
        />

        {profit ? (
          <AdminOrderProfitPanel
            orderId={String(data.order_id)}
            canEdit={canSeeProfit}
            profit={{
              grossRevenue: profit.grossRevenue,
              merchandiseRevenue: profit.merchandiseRevenue,
              shippingCharged: profit.shippingCharged,
              additionalRevenue: profit.additionalRevenue,
              taxCountedAsProfit: profit.taxCountedAsProfit,
              cogs: profit.cogs,
              shippingCost: profit.shippingCost,
              shippingCostIsEstimate: profit.shippingCostIsEstimate,
              shippingCostSource: profit.shippingCostSource,
              shippingProfit: profit.shippingProfit,
              processingFee: profit.processingFee,
              commission: profit.commission,
              refund: profit.refund,
              taxCollected: profit.taxCollected,
              profit: profit.profit,
              marginPercent: profit.marginPercent,
              profitStatus: profit.profitStatus,
              hasEstimatedCost: profit.hasEstimatedCost,
            }}
            audit={shippingAudit.map((entry) => ({
              id: entry.id,
              estimatedCostCents: entry.estimatedCostCents,
              exactCostCents: entry.exactCostCents,
              differenceCents: entry.differenceCents,
              source: entry.source,
              finalizedNetProfitCents: entry.finalizedNetProfitCents,
              createdAt: entry.createdAt,
            }))}
          />
        ) : null}

        <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-300">Charges</h2>
          <dl className="mt-3 space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-zinc-400">Subtotal</dt><dd className="text-zinc-200 tabular-nums">{money(Number(data.subtotal ?? 0))}</dd></div>
            {Number(data.discount_amount ?? 0) > 0 ? <div className="flex justify-between"><dt className="text-zinc-400">Discount</dt><dd className="text-zinc-200 tabular-nums">−{money(Number(data.discount_amount ?? 0))}</dd></div> : null}
            <div className="flex justify-between"><dt className="text-zinc-400">Shipping</dt><dd className="text-zinc-200 tabular-nums">{money(Number(data.shipping_amount ?? 0))}</dd></div>
            <div className="flex justify-between">
              <dt className="text-zinc-400">
                Sales tax
                {data.tax_state ? <span className="text-zinc-500"> ({String(data.tax_state)}{Number(data.tax_rate_percent ?? 0) > 0 ? ` · ${Number(data.tax_rate_percent)}%` : ""})</span> : null}
              </dt>
              <dd className="text-zinc-200 tabular-nums">{money(Number(data.tax_amount ?? 0))}</dd>
            </div>
            {Number(data.card_processing_fee ?? 0) > 0 ? <div className="flex justify-between"><dt className="text-zinc-400">Card processing fee</dt><dd className="text-zinc-200 tabular-nums">{money(Number(data.card_processing_fee ?? 0))}</dd></div> : null}
            <div className="flex justify-between border-t border-white/10 pt-1.5 font-semibold"><dt className="text-zinc-300">Total charged</dt><dd className="tabular-nums text-white">{money(Number(data.amount_paid ?? 0))}</dd></div>
          </dl>
        </section>

        <AdminOrderTimeline entries={auditRows ?? []} />

        <pre className="mt-6 overflow-x-auto rounded-xl bg-zinc-950 p-3 text-xs text-zinc-300 sm:p-4 sm:text-sm">
{JSON.stringify(data, null, 2)}
        </pre>
      </div>
    </div>
  );
}
