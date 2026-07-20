import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

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

export async function getAdminCustomers(filters: AdminCustomerFilters = {}): Promise<AdminCustomerListResult> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("customer_email, customer_name, amount_paid, payment_status, created_at")
    .not("customer_email", "is", null)
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
    const isPaid = PAID_STATUSES.has(String(order.payment_status ?? ""));
    const amount = isPaid ? Number(order.amount_paid ?? 0) : 0;
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

  const search = filters.search?.trim().toLowerCase();
  if (search) {
    customers = customers.filter((row) => row.email.includes(search) || (row.name ?? "").toLowerCase().includes(search));
  }

  customers.sort((a, b) => (a.lastOrderAt < b.lastOrderAt ? 1 : -1));

  const total = customers.length;
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(filters.pageSize ?? 25)));
  const from = (page - 1) * pageSize;

  return {
    rows: customers.slice(from, from + pageSize),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}
