import { notFound, redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { supabaseAdmin } from "@/lib/supabase-server";
import { AdminOrderActions } from "@/components/admin-order-actions";
import { AdminOrderTimeline } from "@/components/admin-order-timeline";

export const dynamic = "force-dynamic";

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

        <AdminOrderTimeline entries={auditRows ?? []} />

        <pre className="mt-6 overflow-x-auto rounded-xl bg-zinc-950 p-3 text-xs text-zinc-300 sm:p-4 sm:text-sm">
{JSON.stringify(data, null, 2)}
        </pre>
      </div>
    </div>
  );
}
