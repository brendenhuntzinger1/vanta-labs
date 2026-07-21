import { redirect } from "next/navigation";
import Link from "next/link";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { getAdminCustomers } from "@/lib/admin-customers";

export const dynamic = "force-dynamic";

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function fmtDate(v: string | null) {
  const d = v && v !== "null" ? new Date(v) : null;
  return d && !isNaN(d.getTime()) ? d.toLocaleDateString() : "—";
}

export default async function AdminCustomersPage({
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
  const page = Math.max(1, Number(params.page) || 1);

  const result = await getAdminCustomers({ search, page, pageSize: 25 }).catch(() => ({ rows: [], total: 0, page: 1, pageSize: 25, pageCount: 1 }));

  const buildPageHref = (targetPage: number) => {
    const query = new URLSearchParams();
    if (search) query.set("search", search);
    query.set("page", String(targetPage));
    return `/admin/customers?${query.toString()}`;
  };

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-2xl font-semibold sm:text-3xl">Customers</h1>
        <p className="mt-2 text-sm text-zinc-400">
          {result.total} customer{result.total === 1 ? "" : "s"} — built from checkout orders. There is no separate
          customer-account system yet, so this reflects guest checkouts grouped by email, not registered accounts.
        </p>

        <form method="GET" className="vl-panel mt-6 flex flex-wrap gap-3 rounded-2xl p-4">
          <input
            type="text"
            name="search"
            defaultValue={search}
            placeholder="Search name or email"
            className="vl-input flex-1 px-3 py-2 text-sm"
          />
          <button type="submit" className="vl-btn-primary px-4 py-2 text-xs">Search</button>
          {search ? <Link href="/admin/customers" className="vl-btn-secondary px-4 py-2 text-xs">Clear</Link> : null}
          <Link href="/api/admin/customers/export" className="vl-btn-secondary px-4 py-2 text-xs">Export CSV</Link>
        </form>

        <div className="vl-panel mt-6 overflow-x-auto rounded-2xl">
          <table className="min-w-full divide-y divide-zinc-800 text-sm">
            <thead className="bg-zinc-900/80">
              <tr>
                <th className="px-4 py-3 text-left">Customer</th>
                <th className="px-4 py-3 text-left">Email</th>
                <th className="px-4 py-3 text-left">Orders</th>
                <th className="px-4 py-3 text-left">Total spent</th>
                <th className="px-4 py-3 text-left">First order</th>
                <th className="px-4 py-3 text-left">Last order</th>
                <th className="px-4 py-3 text-left">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 bg-zinc-950/70">
              {result.rows.map((customer) => (
                <tr key={customer.email}>
                  <td className="px-4 py-3">{customer.name ?? "—"}</td>
                  <td className="px-4 py-3 text-zinc-400">{customer.email}</td>
                  <td className="px-4 py-3">{customer.orderCount}</td>
                  <td className="px-4 py-3">{money(customer.totalSpent)}</td>
                  <td className="px-4 py-3 text-xs text-zinc-400">{fmtDate(customer.firstOrderAt)}</td>
                  <td className="px-4 py-3 text-xs text-zinc-400">{fmtDate(customer.lastOrderAt)}</td>
                  <td className="px-4 py-3">
                    <Link href={`/admin/orders?search=${encodeURIComponent(customer.email)}`} className="text-xs text-cyan-300 hover:underline">
                      View orders
                    </Link>
                  </td>
                </tr>
              ))}
              {result.rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-sm text-zinc-500">No customers match this search.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

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
