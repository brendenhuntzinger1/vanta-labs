import { notFound, redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { supabaseAdmin } from "@/lib/supabase-server";
import { AdminOrderActions } from "@/components/admin-order-actions";
import { AdminOrderTimeline } from "@/components/admin-order-timeline";
import { getOrderProfit } from "@/lib/admin-profit";

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

  const profit = await getOrderProfit(orderId).catch(() => null);

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
        />

        {profit ? (
          <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-300">Profit (internal)</h2>
              <span className="text-[11px] text-zinc-500">Snapshot cost · not shown to customers</span>
            </div>
            <dl className="mt-3 space-y-1.5 text-sm">
              <div className="flex justify-between"><dt className="text-zinc-400">Merchandise revenue</dt><dd className="text-zinc-200 tabular-nums">{money(profit.merchandiseRevenue)}</dd></div>
              <div className="flex justify-between"><dt className="text-zinc-400">Shipping revenue</dt><dd className="text-zinc-200 tabular-nums">{money(profit.shippingRevenue)}</dd></div>
              <div className="flex justify-between"><dt className="text-zinc-400">− Product cost (COGS)</dt><dd className="text-rose-300 tabular-nums">{money(-profit.cogs)}</dd></div>
              <div className="flex justify-between"><dt className="text-zinc-400">− Ambassador commission</dt><dd className="text-rose-300 tabular-nums">{money(-profit.commission)}</dd></div>
              <div className="flex justify-between"><dt className="text-zinc-400">− Processing fee</dt><dd className="text-rose-300 tabular-nums">{money(-profit.processingFee)}</dd></div>
              <div className="flex justify-between"><dt className="text-zinc-400">− Shipping cost</dt><dd className="text-rose-300 tabular-nums">{money(-profit.shippingCost)}</dd></div>
              {profit.refund > 0 ? <div className="flex justify-between"><dt className="text-zinc-400">− Refunds</dt><dd className="text-rose-300 tabular-nums">{money(-profit.refund)}</dd></div> : null}
              <div className="mt-2 flex justify-between border-t border-white/10 pt-2 text-base font-semibold">
                <dt className={profit.profit >= 0 ? "text-emerald-300" : "text-rose-300"}>Net profit</dt>
                <dd className={`tabular-nums ${profit.profit >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{money(profit.profit)} <span className="text-xs font-normal text-zinc-500">({profit.marginPercent.toFixed(1)}%)</span></dd>
              </div>
            </dl>
            {profit.hasEstimatedCost ? (
              <p className="mt-3 text-[11px] text-amber-300/90">⚠ Some items had no cost recorded at checkout — their cost is estimated at the worst-case assumption, so this profit is an estimate for those lines.</p>
            ) : null}
          </section>
        ) : null}

        <AdminOrderTimeline entries={auditRows ?? []} />

        <pre className="mt-6 overflow-x-auto rounded-xl bg-zinc-950 p-3 text-xs text-zinc-300 sm:p-4 sm:text-sm">
{JSON.stringify(data, null, 2)}
        </pre>
      </div>
    </div>
  );
}
