import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

// Every homepage/promotions/settings save in the control center writes a
// new row here too (src/lib/admin-control.ts, action "admin_control_upsert")
// - one per field, per save. Left in by default this would drown out real
// operational events (refunds, status changes, coupon edits), so the
// viewer excludes it unless explicitly requested.
const CONFIG_ACTION = "admin_control_upsert";

export interface AuditLogRow {
  id: string;
  action: string;
  targetTable: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditLogFilters {
  action?: string;
  targetTable?: string;
  includeConfigSaves?: boolean;
  page?: number;
  pageSize?: number;
}

export interface AuditLogListResult {
  rows: AuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

function sanitizeTerm(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_\- ]/g, "").slice(0, 60);
}

export async function getAuditLogRows(filters: AuditLogFilters = {}): Promise<AuditLogListResult> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(filters.pageSize ?? 30)));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabaseAdmin
    .from("admin_audit_logs")
    .select("id, action, target_table, target_id, metadata, created_at", { count: "exact" })
    .order("created_at", { ascending: false });

  if (!filters.includeConfigSaves) {
    query = query.neq("action", CONFIG_ACTION);
  }

  const action = sanitizeTerm(filters.action ?? "");
  if (action) {
    query = query.ilike("action", `%${action}%`);
  }

  const targetTable = sanitizeTerm(filters.targetTable ?? "");
  if (targetTable && targetTable !== "all") {
    query = query.eq("target_table", targetTable);
  }

  const { data, error, count } = await query.range(from, to);

  if (error) {
    throw error;
  }

  const total = count ?? 0;

  return {
    rows: (data ?? []).map((row) => ({
      id: String(row.id),
      action: String(row.action),
      targetTable: row.target_table,
      targetId: row.target_id,
      metadata: (row.metadata ?? null) as Record<string, unknown> | null,
      createdAt: row.created_at,
    })),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getAuditLogTargetTables(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("admin_audit_logs")
    .select("target_table")
    .neq("action", CONFIG_ACTION)
    .not("target_table", "is", null)
    .limit(2000);

  if (error) {
    throw error;
  }

  const tables = new Set<string>();
  for (const row of data ?? []) {
    if (row.target_table) {
      tables.add(String(row.target_table));
    }
  }

  return Array.from(tables).sort();
}
