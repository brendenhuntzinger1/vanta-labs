import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { netOrderRevenue } from "@/lib/ledger";
import { readAllRowsBounded } from "@/lib/supabase-page";

// There is no customer-account system yet (Phase 5) - this aggregates the
// guest checkout orders already in Supabase by email. It is a reporting
// view over orders, not a real customer record: a shopper who never
// creates an account only exists here because they checked out at least
// once.
const PAID_STATUSES = new Set(["paid", "partially_refunded", "refunded"]);

export interface AdminCustomerRow {
  email: string;
  name: string | null;
  orderCount: number;
  totalSpent: number;
  firstOrderAt: string;
  lastOrderAt: string;
}

export interface AdminCustomerFilters {
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface AdminCustomerListResult {
  rows: AdminCustomerRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

async function aggregateCustomers(search?: string): Promise<AdminCustomerRow[]> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("customer_email, customer_name, amount_paid, refund_amount, payment_status, created_at")
    .not("customer_email", "is", null)
    // A warranty reship is written as a paid order under the ORIGINAL BUYER'S
    // email (admin-replacements.ts), so it would be counted here as an order
    // this customer placed. It is the store's own shipment. Excluded to match
    // admin_customer_rollup's `agg` CTE — see M-14 in admin-dashboard-rollups.sql.
    // The two must agree, or /admin/customers changes meaning depending on
    // whether the rollup migration happens to be present. `orders.order_type` is
    // `text not null default 'product'`, so `neq` cannot silently drop rows to a
    // null comparison.
    .neq("order_type", "replacement")
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) {
    throw error;
  }

  const byEmail = new Map<string, AdminCustomerRow>();

  for (const order of data ?? []) {
    const email = String(order.customer_email ?? "").trim().toLowerCase();
    if (!email) continue;

    const existing = byEmail.get(email);
    // NET, NOT GROSS. This summed raw `amount_paid`, so a fully refunded order
    // still counted its whole value toward the customer's lifetime spend and a
    // partially refunded one counted the part that was handed back. Every other
    // revenue surface in this codebase — /admin/revenue, analytics, email
    // attribution, membership revenue and the SQL rollups — uses
    // ledger.netOrderRevenue, and "what this customer has actually spent with
    // us" is the same question. Which ROWS are counted is unchanged; only the
    // amount is, and a fully refunded order now contributes 0 rather than its
    // face value.
    const isPaid = PAID_STATUSES.has(String(order.payment_status ?? ""));
    const amount = isPaid ? netOrderRevenue(order) : 0;
    const createdAt = String(order.created_at);

    if (!existing) {
      byEmail.set(email, {
        email,
        name: order.customer_name ? String(order.customer_name) : null,
        orderCount: 1,
        totalSpent: amount,
        firstOrderAt: createdAt,
        lastOrderAt: createdAt,
      });
      continue;
    }

    existing.orderCount += 1;
    existing.totalSpent += amount;
    if (createdAt > existing.lastOrderAt) {
      existing.lastOrderAt = createdAt;
      if (order.customer_name) existing.name = String(order.customer_name);
    }
    if (createdAt < existing.firstOrderAt) {
      existing.firstOrderAt = createdAt;
    }
  }

  let customers = Array.from(byEmail.values());

  const normalizedSearch = search?.trim().toLowerCase();
  if (normalizedSearch) {
    customers = customers.filter((row) => row.email.includes(normalizedSearch) || (row.name ?? "").toLowerCase().includes(normalizedSearch));
  }

  customers.sort((a, b) => (a.lastOrderAt < b.lastOrderAt ? 1 : -1));

  return customers;
}

// Sanitize admin search input before it reaches the RPC's LIKE pattern — strip
// LIKE metacharacters so a stray % or _ can't turn into an unintended wildcard.
function sanitizeSearch(search?: string): string | null {
  const normalized = (search ?? "").trim().replace(/[%_\\]/g, "").slice(0, 100);
  return normalized || null;
}

function mapRpcRow(row: Record<string, unknown>): AdminCustomerRow {
  return {
    email: String(row.email ?? ""),
    name: row.name ? String(row.name) : null,
    orderCount: Number(row.order_count ?? 0),
    totalSpent: Number(row.total_spent ?? 0),
    firstOrderAt: String(row.first_order_at ?? ""),
    lastOrderAt: String(row.last_order_at ?? ""),
  };
}

// Aggregate + filter + paginate entirely in Postgres (no row transfer, no cap).
// Returns null when the RPC isn't migrated yet so callers can fall back to the
// legacy JS aggregation. p_limit null = all rows (export).
async function rpcCustomerRows(
  search: string | null,
  limit: number | null,
  offset: number,
): Promise<{ rows: AdminCustomerRow[]; total: number } | null> {
  const { data, error } = await supabaseAdmin.rpc("admin_customer_rollup", {
    p_search: search,
    p_limit: limit,
    p_offset: offset,
  });
  if (error || !Array.isArray(data)) {
    return null;
  }
  const rows = (data as Array<Record<string, unknown>>).map(mapRpcRow);
  const total = data.length > 0 ? Number((data[0] as Record<string, unknown>).total_count ?? rows.length) : 0;
  return { rows, total };
}

export async function getAdminCustomers(filters: AdminCustomerFilters = {}): Promise<AdminCustomerListResult> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(filters.pageSize ?? 25)));
  const from = (page - 1) * pageSize;

  const rpc = await rpcCustomerRows(sanitizeSearch(filters.search), pageSize, from);
  if (rpc) {
    return {
      rows: rpc.rows,
      total: rpc.total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(rpc.total / pageSize)),
    };
  }

  // Fallback: RPC not present — legacy 5k-capped JS aggregation + slice.
  const customers = await aggregateCustomers(filters.search);
  const total = customers.length;
  return {
    rows: customers.slice(from, from + pageSize),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function csvEscape(value: unknown) {
  let text = String(value ?? "");
  // Neutralize spreadsheet formula injection from attacker-controlled cells
  // (customer name/email) — a leading = + - @ / tab / CR would run as a formula
  // in Excel/Sheets. Prefix a single quote.
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll("\"", "\"\"")}"`;
  }
  return text;
}

// Ceiling on the export. Bounds memory for a file an admin downloads; the read
// below observes whether it bound the answer, and says so rather than handing
// over a CSV that is quietly missing customers.
const MAX_EXPORT_ROWS = 200_000;

export async function exportCustomersCsv(): Promise<string> {
  // The RPC aggregates in Postgres, but the RESPONSE still comes back through
  // PostgREST, which caps it at db-max-rows (1,000) and says nothing — so
  // "p_limit null = all rows" was true of the function and false of the export.
  // Page it through the RPC's own p_limit/p_offset, advancing by the rows
  // actually received and stopping only on an empty page.
  const rpc = await readAllRowsBounded<AdminCustomerRow>(
    async (from, to) => {
      const page = await rpcCustomerRows(null, to - from + 1, from);
      // null means the RPC isn't migrated — surface it as an error so the
      // legacy fallback below still runs instead of exporting an empty file.
      if (!page) return { data: null, error: new Error("admin_customer_rollup unavailable") };
      return { data: page.rows, error: null };
    },
    { maxRows: MAX_EXPORT_ROWS, label: "customer export" },
  ).catch(() => null);

  if (rpc?.truncated) {
    throw new Error(
      `Customer export exceeded ${MAX_EXPORT_ROWS} rows; refusing to download a file that silently stops part-way.`,
    );
  }

  const customers = rpc ? rpc.rows : await aggregateCustomers();
  const header = ["email", "name", "orderCount", "totalSpent", "firstOrderAt", "lastOrderAt"];

  return [
    header.join(","),
    ...customers.map((row) => header.map((key) => csvEscape(row[key as keyof AdminCustomerRow])).join(",")),
  ].join("\n");
}
