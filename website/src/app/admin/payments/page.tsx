import { redirect } from "next/navigation";
import Link from "next/link";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { getManualPaymentRows, type AdminPaymentStatusFilter } from "@/lib/admin-payments";
import { getPaymentMethodsConfig } from "@/lib/admin-control";
import { getEnabledPaymentMethods, isManualPaymentMethod } from "@/lib/payment-methods";
import { AdminPaymentsClient } from "@/components/admin-payments-client";

export const dynamic = "force-dynamic";

const STATUS_OPTIONS: AdminPaymentStatusFilter[] = [
  "all",
  "awaiting_verification",
  "pending_payment",
  "paid",
  "payment_rejected",
];

function statusLabel(value: string) {
  return value === "all" ? "All statuses" : value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export default async function AdminPaymentsPage({
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
  const paymentStatus = (typeof params.paymentStatus === "string" ? params.paymentStatus : "all") as AdminPaymentStatusFilter;
  const paymentMethod = typeof params.paymentMethod === "string" ? params.paymentMethod : "all";
  const fromDate = typeof params.fromDate === "string" ? params.fromDate : "";
  const toDate = typeof params.toDate === "string" ? params.toDate : "";
  const page = Math.max(1, Number(params.page) || 1);

  const [result, methods] = await Promise.all([
    getManualPaymentRows({ search, paymentStatus, paymentMethod, fromDate, toDate, page, pageSize: 25 }).catch(() => ({ rows: [], total: 0, page: 1, pageSize: 25, pageCount: 1 })),
    getPaymentMethodsConfig().catch(() => []),
  ]);

  const manualMethods = getEnabledPaymentMethods(methods).filter(isManualPaymentMethod);

  const buildPageHref = (targetPage: number) => {
    const query = new URLSearchParams();
    if (search) query.set("search", search);
    if (paymentStatus !== "all") query.set("paymentStatus", paymentStatus);
    if (paymentMethod !== "all") query.set("paymentMethod", paymentMethod);
    if (fromDate) query.set("fromDate", fromDate);
    if (toDate) query.set("toDate", toDate);
    query.set("page", String(targetPage));
    return `/admin/payments?${query.toString()}`;
  };

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold sm:text-3xl">Payment Verification</h1>
            <p className="mt-2 text-sm text-zinc-400">
              {result.total} manual payment{result.total === 1 ? "" : "s"} — approve to send straight to fulfillment.
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/admin/payments/settings" className="vl-btn-secondary inline-flex px-4 py-2 text-xs">
              Payment Settings
            </Link>
            <Link href="/admin/fulfillment" className="vl-btn-secondary inline-flex px-4 py-2 text-xs">
              Fulfillment Queue →
            </Link>
          </div>
        </div>

        <form method="GET" className="vl-panel mt-6 grid gap-3 rounded-2xl p-4 sm:grid-cols-6">
          <input
            type="text"
            name="search"
            defaultValue={search}
            placeholder="Search order #, name, email, transaction ID"
            className="vl-input px-3 py-2 text-sm sm:col-span-2"
          />
          <select name="paymentStatus" defaultValue={paymentStatus} className="vl-input px-3 py-2 text-sm">
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>{statusLabel(status)}</option>
            ))}
          </select>
          <select name="paymentMethod" defaultValue={paymentMethod} className="vl-input px-3 py-2 text-sm">
            <option value="all">All methods</option>
            {manualMethods.map((method) => (
              <option key={method.id} value={method.id}>{method.label}</option>
            ))}
          </select>
          <input type="date" name="fromDate" defaultValue={fromDate} className="vl-input px-3 py-2 text-sm" aria-label="From date" />
          <input type="date" name="toDate" defaultValue={toDate} className="vl-input px-3 py-2 text-sm" aria-label="To date" />
          <div className="sm:col-span-6">
            <button type="submit" className="vl-btn-primary px-4 py-2 text-xs">Apply filters</button>
            {search || paymentStatus !== "all" || paymentMethod !== "all" || fromDate || toDate ? (
              <Link href="/admin/payments" className="ml-3 text-xs text-zinc-400 hover:text-white">Clear</Link>
            ) : null}
          </div>
        </form>

        <AdminPaymentsClient rows={result.rows} />

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
