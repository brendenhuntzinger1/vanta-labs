import { redirect } from "next/navigation";
import Link from "next/link";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import {
  getAdminOrderRows,
  type AdminOrderFulfillmentStatusFilter,
  type AdminOrderPaymentStatusFilter,
} from "@/lib/admin-orders";
import { AdminOrdersClient } from "@/components/admin-orders-client";

export const dynamic = "force-dynamic";

const PAYMENT_STATUS_OPTIONS: AdminOrderPaymentStatusFilter[] = [
  "all",
  "pending_payment",
  "paid",
  "partially_refunded",
  "refunded",
  "payment_failed",
  "canceled",
];

const FULFILLMENT_STATUS_OPTIONS: AdminOrderFulfillmentStatusFilter[] = [
  "all",
  "pending",
  "awaiting_fulfillment",
  "shipped",
  "delivered",
  "cancelled",
];

function statusLabel(value: string) {
  return value === "all" ? "All" : value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  const params = await searchParams;
  const search = typeof params.search === "string" ? params.search : "";
  const paymentStatus = (typeof params.paymentStatus === "string" ? params.paymentStatus : "all") as AdminOrderPaymentStatusFilter;
  const fulfillmentStatus = (typeof params.fulfillmentStatus === "string" ? params.fulfillmentStatus : "all") as AdminOrderFulfillmentStatusFilter;
  const page = Math.max(1, Number(params.page) || 1);

  const result = await getAdminOrderRows({ search, paymentStatus, fulfillmentStatus, page, pageSize: 25 });

  const buildPageHref = (targetPage: number) => {
    const query = new URLSearchParams();
    if (search) query.set("search", search);
    if (paymentStatus !== "all") query.set("paymentStatus", paymentStatus);
    if (fulfillmentStatus !== "all") query.set("fulfillmentStatus", fulfillmentStatus);
    query.set("page", String(targetPage));
    return `/admin/orders?${query.toString()}`;
  };

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold sm:text-3xl">Admin Orders</h1>
            <p className="mt-2 text-sm text-zinc-400">{result.total} order{result.total === 1 ? "" : "s"} — real Supabase orders and commissions.</p>
          </div>
          <Link href="/api/admin/orders/export" className="vl-btn-secondary inline-flex px-4 py-2 text-xs">
            Export Orders CSV
          </Link>
        </div>

        <form method="GET" className="vl-panel mt-6 grid gap-3 rounded-2xl p-4 sm:grid-cols-4">
          <input
            type="text"
            name="search"
            defaultValue={search}
            placeholder="Search order ID, email, or name"
            className="vl-input px-3 py-2 text-sm sm:col-span-2"
          />
          <select name="paymentStatus" defaultValue={paymentStatus} className="vl-input px-3 py-2 text-sm">
            {PAYMENT_STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>{statusLabel(status)} payment</option>
            ))}
          </select>
          <select name="fulfillmentStatus" defaultValue={fulfillmentStatus} className="vl-input px-3 py-2 text-sm">
            {FULFILLMENT_STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>{statusLabel(status)} fulfillment</option>
            ))}
          </select>
          <div className="sm:col-span-4">
            <button type="submit" className="vl-btn-primary px-4 py-2 text-xs">Apply filters</button>
            {search || paymentStatus !== "all" || fulfillmentStatus !== "all" ? (
              <Link href="/admin/orders" className="ml-3 text-xs text-zinc-400 hover:text-white">Clear</Link>
            ) : null}
          </div>
        </form>

        <AdminOrdersClient orders={result.rows} />

        {result.pageCount > 1 ? (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {Array.from({ length: result.pageCount }, (_, index) => index + 1).map((pageNumber) => (
              <Link
                key={pageNumber}
                href={buildPageHref(pageNumber)}
                className={pageNumber === result.page
                  ? "rounded-lg border border-cyan-300/40 bg-cyan-400/15 px-3 py-1.5 text-xs font-semibold text-cyan-100"
                  : "rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-zinc-300 hover:border-white/25 hover:text-white"}
              >
                {pageNumber}
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
