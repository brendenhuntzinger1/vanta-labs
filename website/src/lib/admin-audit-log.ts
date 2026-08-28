import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { readAllRowsBounded } from "@/lib/supabase-page";
import { redactAuditMetadata } from "@/lib/admin-audit-redaction";

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
      // Redacted at the AUDIT read boundary. This table doubles as the
      // settings store, so the raw value has to stay in the row for
      // getControlSnapshot -- but nothing reading it as an audit log has any
      // business seeing an SMTP password or a provider API key. See
      // admin-audit-redaction.ts.
      metadata: redactAuditMetadata({
        action: String(row.action),
        targetTable: row.target_table,
        targetId: row.target_id,
        metadata: (row.metadata ?? null) as Record<string, unknown> | null,
      }),
      createdAt: row.created_at,
    })),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getAuditLogTargetTables(): Promise<string[]> {
  // This builds the "target table" FILTER options, so it has to see every
  // distinct value in the log or the dropdown silently stops offering some of
  // them - and an operator who cannot select a table reasonably concludes
  // nothing was ever done to it.
  //
  // `.limit(2000)` could not do that. PostgREST caps a single response at
  // `db-max-rows` (Supabase ships 1000) and does it SILENTLY, so the request
  // was never able to exceed the cap it was written to raise - see the
  // supabase-page.ts docblock. Paging is the only way to read past it.
  //
  // Ordered by the primary key because paging without a stable total order can
  // return one row twice and skip another. Cost is one request per 1000 rows
  // plus a terminating one, on a page an operator opens deliberately.
  const { rows } = await readAllRowsBounded<{ target_table: string | null }>(
    (from, to) =>
      supabaseAdmin
        .from("admin_audit_logs")
        .select("target_table")
        .neq("action", CONFIG_ACTION)
        .not("target_table", "is", null)
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: { target_table: string | null }[] | null; error: unknown }>,
    { maxRows: 200_000, label: "audit log target tables" },
  );

  const tables = new Set<string>();
  for (const row of rows) {
    if (row.target_table) {
      tables.add(String(row.target_table));
    }
  }

  return Array.from(tables).sort();
}
