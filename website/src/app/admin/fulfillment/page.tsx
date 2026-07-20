import { redirect } from "next/navigation";
import Link from "next/link";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { getFulfillmentRows, type FulfillmentStatusFilter } from "@/lib/admin-fulfillment";
import { AdminFulfillmentClient } from "@/components/admin-fulfillment-client";

export const dynamic = "force-dynamic";

const STATUS_OPTIONS: { value: FulfillmentStatusFilter; label: string }[] = [
  { value: "queue", label: "Ready for fulfillment" },
  { value: "shipped", label: "Shipped" },
  { value: "delivered", label: "Delivered" },
  { value: "all", label: "All paid orders" },
];

export default async function AdminFulfillmentPage({
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
  const status = (typeof params.status === "string" ? params.status : "queue") as FulfillmentStatusFilter;
  const page = Math.max(1, Number(params.page) || 1);

  const result = await getFulfillmentRows({ search, status, page, pageSize: 25 });

  const buildPageHref = (targetPage: number) => {
    const query = new URLSearchParams();
    if (search) query.set("search", search);
    if (status !== "queue") query.set("status", status);
    query.set("page", String(targetPage));
    return `/admin/fulfillment?${query.toString()}`;
  };

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold sm:text-3xl">Fulfillment Queue</h1>
            <p className="mt-2 text-sm text-zinc-400">
              {result.total} order{result.total === 1 ? "" : "s"} — 3PL-friendly view. Copy the Order Number to send to your fulfillment partner.
            </p>
          </div>
          <Link href="/admin/payments" className="vl-btn-secondary inline-flex px-4 py-2 text-xs">
            ← Payment Verification
          </Link>
        </div>

        <form method="GET" className="vl-panel mt-6 grid gap-3 rounded-2xl p-4 sm:grid-cols-4">
          <input
            type="text"
            name="search"
            defaultValue={search}
            placeholder="Search order #, name, email, tracking #"
            className="vl-input px-3 py-2 text-sm sm:col-span-2"
          />
          <select name="status" defaultValue={status} className="vl-input px-3 py-2 text-sm">
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <div className="flex items-center gap-3">
            <button type="submit" className="vl-btn-primary px-4 py-2 text-xs">Apply</button>
            {search || status !== "queue" ? (
              <Link href="/admin/fulfillment" className="text-xs text-zinc-400 hover:text-white">Clear</Link>
            ) : null}
          </div>
        </form>

        <AdminFulfillmentClient rows={result.rows} />

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
