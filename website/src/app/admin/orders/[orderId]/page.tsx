import { notFound, redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageRefunds, canViewProfit } from "@/lib/admin-roles";
import { supabaseAdmin } from "@/lib/supabase-server";
import { AdminOrderActions } from "@/components/admin-order-actions";
import { AdminOrderTimeline } from "@/components/admin-order-timeline";
import { AdminOrderProfitPanel } from "@/components/admin-order-profit-panel";
import {
  AdminOrderShippingPanel,
  type ShippingPanelItem,
  type ShippingPanelPreset,
} from "@/components/admin-order-shipping-panel";
import { getOrderProfit, getShippingCostAudit } from "@/lib/admin-profit";
import { parseOrderItemRef } from "@/lib/inventory-fulfillment";
import { getShippoStatus } from "@/lib/shippo/config";
import { listPackagePresets } from "@/lib/shippo/packages";
import { buildOrderParcel } from "@/lib/shippo/service";
import { buildCarrierTrackingUrl } from "@/lib/tracking-url";

export const dynamic = "force-dynamic";

function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

/** Payment states that are allowed to ship. Everything else keeps the workstation read-only. */
const SHIPPABLE_PAYMENT_STATES = new Set(["paid", "partially_refunded"]);

function presetView(preset: {
  id: string;
  name: string;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  emptyWeightOz: number;
  isDefault?: boolean;
}): ShippingPanelPreset {
  return {
    id: preset.id,
    name: preset.name,
    lengthIn: preset.lengthIn,
    widthIn: preset.widthIn,
    heightIn: preset.heightIn,
    emptyWeightOz: preset.emptyWeightOz,
    isDefault: preset.isDefault,
  };
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

  const [parcelResult, packagePresets] = isPhysicalOrder
    ? await Promise.all([
        buildOrderParcel(orderId).catch(() => null),
        listPackagePresets().catch(() => []),
      ])
    : [null, []];
  const parcelData = parcelResult?.ok ? parcelResult.data : null;

  const rawOrderItems = (data.order_items ?? []) as Array<{
    id: string | number;
    product_name?: string | null;
    product_id?: string | null;
    quantity?: number | null;
  }>;

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

  const shippingItems: ShippingPanelItem[] = parcelData
    ? parcelData.lines.map((line, index) => ({
        key: `${line.productId}-${index}`,
        name: line.name,
        sku: skuBySlug.get(parseOrderItemRef(line.productId).slug) ?? null,
        quantity: line.quantity,
        unitWeightOz: line.unitWeightOz,
        lineWeightOz: line.lineWeightOz,
      }))
    : rawOrderItems.map((item, index) => ({
        key: `${String(item.id)}-${index}`,
        name: String(item.product_name ?? item.product_id ?? "Item"),
        sku: skuBySlug.get(parseOrderItemRef(String(item.product_id ?? "")).slug) ?? null,
        quantity: Math.max(1, Number(item.quantity ?? 1)),
        unitWeightOz: null,
        lineWeightOz: null,
      }));

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

  const presetOptions = packagePresets.map(presetView);
  // An order can point at a preset that has since been deactivated; keep it in
  // the picker so the select does not silently jump to something else.
  if (parcelData?.preset && !presetOptions.some((preset) => preset.id === parcelData.preset?.id)) {
    presetOptions.unshift(presetView(parcelData.preset));
  }

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="vl-panel mx-auto max-w-5xl rounded-2xl p-4 sm:p-8">
        <h1 className="break-all text-2xl font-semibold sm:text-3xl">{data.order_id}</h1>
        <p className="mt-2 text-sm text-zinc-400">Customer: {data.customer_email}</p>

        {isPhysicalOrder ? (
          <AdminOrderShippingPanel
            orderId={String(data.order_id)}
            orderNumber={String(data.order_number ?? data.order_id)}
            customerName={data.customer_name ? String(data.customer_name) : null}
            customerEmail={data.customer_email ? String(data.customer_email) : null}
            customerPhone={data.phone ? String(data.phone) : null}
            address={{
              street1: data.shipping_address ? String(data.shipping_address) : null,
              street2: data.shipping_address_2 ? String(data.shipping_address_2) : null,
              city: data.city ? String(data.city) : null,
              state: data.state ? String(data.state) : null,
              zip: data.postal_code ? String(data.postal_code) : null,
              country: data.country ? String(data.country) : null,
            }}
            items={shippingItems}
            orderTotal={Number(data.amount_paid ?? 0)}
            shippingCharged={Number(data.shipping_amount ?? 0)}
            paymentStatus={String(data.payment_status ?? "pending_payment")}
            fulfillmentStatus={String(data.fulfillment_status ?? "pending")}
            canFulfill={SHIPPABLE_PAYMENT_STATES.has(String(data.payment_status ?? "").toLowerCase())}
            parcel={{
              weightOz: parcelData ? parcelData.weightOz : null,
              merchandiseOz: parcelData ? parcelData.merchandiseOz : null,
              packagingOz: parcelData ? parcelData.packagingOz : null,
              weightReviewRequired: parcelData ? parcelData.weightReviewRequired : false,
              overridden: parcelData?.overridden ?? false,
              overrideOz:
                data.parcel_weight_oz_override == null ? null : Number(data.parcel_weight_oz_override),
              preset: parcelData?.preset ? presetView(parcelData.preset) : null,
              error: parcelResult && !parcelResult.ok ? parcelResult.message : null,
            }}
            packages={presetOptions}
            shippoOrderId={data.shippo_order_id ? String(data.shippo_order_id) : null}
            shippoSyncStatus={data.shippo_sync_status ? String(data.shippo_sync_status) : null}
            shippoSyncError={data.shippo_sync_error ? String(data.shippo_sync_error) : null}
            label={shippingLabel}
            labelVoidedAt={labelVoidedAt}
            // The claim is held but no label landed: another request is mid-flight,
            // or one died after taking the claim. Either way, do not buy again.
            purchaseClaimStuck={Boolean(data.label_purchase_claimed_at) && !shippoTransactionId}
            paidAt={data.paid_at ? String(data.paid_at) : null}
            packedAt={data.packed_at ? String(data.packed_at) : null}
            shippedAt={data.shipped_at ? String(data.shipped_at) : null}
            deliveredAt={data.delivered_at ? String(data.delivered_at) : null}
            shippo={{ configured: shippoStatus.configured, mode: shippoStatus.mode, label: shippoStatus.label }}
          />
        ) : null}

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
