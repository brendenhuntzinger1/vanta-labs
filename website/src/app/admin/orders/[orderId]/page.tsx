import { notFound, redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageRefunds, canViewProfit } from "@/lib/admin-roles";
import { supabaseAdmin } from "@/lib/supabase-server";
import { AdminOrderActions } from "@/components/admin-order-actions";
import { AdminOrderTimeline } from "@/components/admin-order-timeline";
import { AdminOrderProfitPanel } from "@/components/admin-order-profit-panel";
import { AdminOrderFulfillmentCard } from "@/components/admin-order-fulfillment-card";
import { AdminOrderCommunications } from "@/components/admin-order-communications";
import { getOrderProfit, getShippingCostAudit } from "@/lib/admin-profit";
import { parseOrderItemRef } from "@/lib/inventory-fulfillment";
import { getShippoStatus } from "@/lib/shippo/config";
import { buildOrderParcel } from "@/lib/shippo/service";
import { buildCarrierTrackingUrl } from "@/lib/tracking-url";

export const dynamic = "force-dynamic";

function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

/** Payment states that are allowed to ship. Everything else keeps the workstation read-only. */
const SHIPPABLE_PAYMENT_STATES = new Set(["paid", "partially_refunded"]);


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

  // -------------------------------------------------------------------------
  // Fulfillment workstation data.
  //
  // Only physical orders get the panel — a membership has nothing to put in a
  // box, and buildOrderParcel refuses one anyway. Every load here is
  // best-effort: a parcel that cannot be built, or a package list that fails,
  // must degrade to a panel that explains itself, never a 500 on the order page.
  // -------------------------------------------------------------------------
  const isPhysicalOrder = String(data.order_type ?? "product") !== "membership";
  const shippoStatus = getShippoStatus();

  // The parcel is still computed -- it is what tells the card whether a SKU is
  // missing a weight -- but the package PRESET LIST is not fetched any more.
  // Choosing a box happens in Shippo, so a picker here had nothing to feed.
  const parcelResult = isPhysicalOrder ? await buildOrderParcel(orderId).catch(() => null) : null;
  const parcelData = parcelResult?.ok ? parcelResult.data : null;

  const rawOrderItems = (data.order_items ?? []) as Array<{
    id: string | number;
    product_name?: string | null;
    product_id?: string | null;
    quantity?: number | null;
  }>;

  // Counted from the same rows the list renders, so the total above the list can
  // never disagree with the lines under it.
  const totalUnits = rawOrderItems.reduce(
    (sum, item) => sum + Math.max(1, Number(item.quantity ?? 1)),
    0,
  );

  // SKUs live on `products`, never on the order line, so resolve them through
  // the same slug the parcel math parses out of order_items.product_id.
  const skuBySlug = new Map<string, string>();
  if (isPhysicalOrder) {
    const productRefs = parcelData
      ? parcelData.lines.map((line) => line.productId)
      : rawOrderItems.map((item) => String(item.product_id ?? ""));
    const slugs = [
      ...new Set(productRefs.map((ref) => parseOrderItemRef(ref).slug).filter((slug) => slug.length > 0)),
    ];
    if (slugs.length > 0) {
      try {
        const { data: productRows } = await supabaseAdmin.from("products").select("slug, sku").in("slug", slugs);
        for (const row of productRows ?? []) {
          if (row.sku) skuBySlug.set(String(row.slug), String(row.sku));
        }
      } catch {
        // A missing sku column or a transient failure leaves the column blank —
        // it is a convenience for picking, not something to fail a page over.
      }
    }
  }

  // A voided label is not a label: it can never be reprinted or reused, so the
  // panel is shown none.
  const labelVoidedAt = data.label_voided_at ? String(data.label_voided_at) : null;
  const shippoTransactionId = data.shippo_transaction_id ? String(data.shippo_transaction_id) : null;
  const labelCarrier = data.shipping_carrier ? String(data.shipping_carrier) : null;
  const labelTracking = data.tracking_number ? String(data.tracking_number) : null;
  const shippingLabel =
    shippoTransactionId && !labelVoidedAt
      ? {
          transactionId: shippoTransactionId,
          carrier: labelCarrier,
          service: data.shipping_service ? String(data.shipping_service) : null,
          trackingNumber: labelTracking,
          trackingUrl: buildCarrierTrackingUrl(labelCarrier, labelTracking),
          // Integer cents, or null for "not known". Never coerced to 0.
          postageCostCents:
            data.postage_cost_cents == null || !Number.isFinite(Number(data.postage_cost_cents))
              ? null
              : Number(data.postage_cost_cents),
          purchasedAt: data.label_purchased_at ? String(data.label_purchased_at) : null,
        }
      : null;

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="vl-panel mx-auto max-w-5xl rounded-2xl p-4 sm:p-8">
        <h1 className="break-all text-2xl font-semibold sm:text-3xl">
          {String(data.order_number ?? data.order_id)}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-white/15 bg-white/[0.05] px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-zinc-200">
            {String(data.payment_status ?? "pending_payment").replace(/_/g, " ")}
          </span>
          <span className="text-xs text-zinc-500">{data.order_id}</span>
        </div>

        {/* Customer and address live on the page now. They used to sit inside
            the fulfillment panel, which meant reading an address required
            loading the whole shipping workstation. */}
        <section className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
            <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Customer</p>
            <p className="mt-2 text-sm text-zinc-100">{String(data.customer_name ?? "—")}</p>
            <p className="mt-1 break-all text-xs text-zinc-400">{String(data.customer_email ?? "—")}</p>
            {data.phone ? <p className="mt-0.5 text-xs text-zinc-400">{String(data.phone)}</p> : null}
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
            <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Shipping address</p>
            <p className="mt-2 whitespace-pre-line break-words text-sm text-zinc-100">
              {[
                data.shipping_address,
                data.shipping_address_2,
                [data.city, data.state].filter(Boolean).join(", ") + (data.postal_code ? ` ${data.postal_code}` : ""),
                data.country,
              ]
                .map((line) => String(line ?? "").trim())
                .filter((line) => line.length > 0)
                .join("\n") || "No address on file"}
            </p>
          </div>
        </section>

        {/* Items: what is in the box, and nothing else. Weights and SKUs moved
            out with the packing workstation -- they belong in Shippo. */}
        <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
          {/* READ AT THE SHELVES, NOT AT A DESK.
              The quantity was small grey text at the end of a row — which is
              exactly how a x3 gets packed as a x1. It is now the largest thing
              on the line, and the total is stated so the parcel can be counted
              against a single number before it is sealed. */}
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-300">Items</h2>
            <p className="text-sm text-zinc-400">
              <span className="tabular-nums text-lg font-semibold text-white">{totalUnits}</span>{" "}
              unit{totalUnits === 1 ? "" : "s"} to pack
            </p>
          </div>
          <ul className="mt-3 divide-y divide-white/5">
            {rawOrderItems.map((item, index) => (
              <li key={`${String(item.id)}-${index}`} className="flex items-center justify-between gap-4 py-3">
                <span className="text-sm text-zinc-100">{String(item.product_name ?? item.product_id ?? "Item")}</span>
                <span className="shrink-0 rounded-lg border border-white/12 bg-white/[0.04] px-3 py-1 text-xl font-semibold tabular-nums text-white">
                  &times;{Math.max(1, Number(item.quantity ?? 1))}
                </span>
              </li>
            ))}
            {rawOrderItems.length === 0 ? <li className="py-2 text-sm text-zinc-500">No items recorded.</li> : null}
          </ul>
        </section>

        {isPhysicalOrder ? (
          <AdminOrderFulfillmentCard
            orderId={String(data.order_id)}
            fulfillmentStatus={String(data.fulfillment_status ?? "pending")}
            shippoOrderId={data.shippo_order_id ? String(data.shippo_order_id) : null}
            shippoSyncStatus={data.shippo_sync_status ? String(data.shippo_sync_status) : null}
            shippoSyncError={data.shippo_sync_error ? String(data.shippo_sync_error) : null}
            label={
              shippingLabel
                ? {
                    carrier: shippingLabel.carrier,
                    service: shippingLabel.service,
                    trackingNumber: shippingLabel.trackingNumber,
                    trackingUrl: shippingLabel.trackingUrl,
                    postageCostCents: shippingLabel.postageCostCents,
                    purchasedAt: shippingLabel.purchasedAt,
                  }
                : null
            }
            canFulfill={SHIPPABLE_PAYMENT_STATES.has(String(data.payment_status ?? "").toLowerCase())}
            weightReviewRequired={parcelData ? parcelData.weightReviewRequired : false}
            shippoConfigured={shippoStatus.configured}
          />
        ) : null}

        <AdminOrderCommunications orderId={String(data.order_id)} />

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
            orderId={orderId}
            profit={{
              grossRevenue: profit.grossRevenue,
              merchandiseRevenue: profit.merchandiseRevenue,
              shippingCharged: profit.shippingCharged,
              additionalRevenue: profit.additionalRevenue,
              creditRedeemed: profit.creditRedeemed,
              taxCountedAsProfit: profit.taxCountedAsProfit,
              processingFeeIsEstimate: profit.processingFeeIsEstimate,
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

      </div>
    </div>
  );
}
