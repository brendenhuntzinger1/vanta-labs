import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// PHASE 11, BUCKET 4 — regressions for the polish findings fixed in this batch.
//
// One is behavioural and gets a real test against a fake PostgREST (ADM-12).
// The rest were not reachable from a unit test at all —
// a comment naming the wrong settings section, a deleted dead function, an
// admin control that must no longer save — so they are held by source-level
// assertions, the same device src/lib/handoff-invariants.test.ts uses.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const SRC = path.resolve(__dirname, "..");

function readSource(relative: string): string {
  return readFileSync(path.join(SRC, relative), "utf8");
}

// ---------------------------------------------------------------------------
// A fake PostgREST, deliberately capped.
//
// The whole point of ADM-12 is that the server silently truncates a single
// response at `db-max-rows`, so a fake that returns everything it is asked for
// cannot reproduce the defect: the old `.limit(2000)` would pass against it.
// This one enforces the cap Supabase ships with.
// ---------------------------------------------------------------------------
const SERVER_MAX_ROWS = 1000;

type Row = Record<string, unknown>;
type Filter = { kind: "eq" | "neq" | "is" | "in" | "notIs"; column: string; value: unknown };

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  /** Forced error for one table's SELECT, used as a "got past the guard" probe. */
  selectError: {} as Record<string, { message: string } | undefined>,
  authUser: { email: "member@example.test", name: "Member" } as { email: string; name: string } | null,
}));

function matches(row: Row, f: Filter): boolean {
  const actual = row[f.column];
  switch (f.kind) {
    case "eq": return String(actual ?? "") === String(f.value ?? "");
    case "neq": return String(actual ?? "") !== String(f.value ?? "");
    case "is": return f.value === null ? actual == null : actual === f.value;
    case "notIs": return f.value === null ? actual != null : actual !== f.value;
    case "in": return (f.value as unknown[]).map(String).includes(String(actual ?? ""));
  }
}

function selectBuilder(table: string, columns: string) {
  const filters: Filter[] = [];
  let orderColumn: string | null = null;
  let ascending = true;
  let limitCount: number | null = null;
  let rangeFrom: number | null = null;
  let rangeTo: number | null = null;

  const run = () => {
    const forced = db.selectError[table];
    if (forced) return { data: null, error: forced, count: null };
    let rows = (db.tables[table] ?? []).filter((row) => filters.every((f) => matches(row, f)));
    if (orderColumn) {
      const column = orderColumn;
      rows = [...rows].sort((a, b) => {
        const av = String(a[column] ?? "");
        const bv = String(b[column] ?? "");
        return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (limitCount != null) rows = rows.slice(0, limitCount);
    if (rangeFrom != null) rows = rows.slice(rangeFrom, rangeTo == null ? undefined : rangeTo + 1);
    // The silent server cap. No error, no flag — the array just stops.
    rows = rows.slice(0, SERVER_MAX_ROWS);
    // To-one embed: `membership_tiers(...)` on customer_memberships.
    const embedsTier = /membership_tiers\s*\(/.test(columns);
    const projected = rows.map((row) => {
      const copy: Row = { ...row };
      if (embedsTier && table === "customer_memberships") {
        copy.membership_tiers = (db.tables.membership_tiers ?? []).find(
          (tier) => String(tier.id ?? "") === String(row.tier_id ?? ""),
        ) ?? null;
      }
      return copy;
    });
    return { data: projected, error: null, count: projected.length };
  };

  const builder: Record<string, unknown> = {
    select(next?: string) { if (next) columns = next; return builder; },
    eq(column: string, value: unknown) { filters.push({ kind: "eq", column, value }); return builder; },
    neq(column: string, value: unknown) { filters.push({ kind: "neq", column, value }); return builder; },
    is(column: string, value: unknown) { filters.push({ kind: "is", column, value }); return builder; },
    in(column: string, value: unknown[]) { filters.push({ kind: "in", column, value }); return builder; },
    not(column: string, op: string, value: unknown) {
      if (op !== "is") throw new Error(`fake PostgREST: unsupported not(${op})`);
      filters.push({ kind: "notIs", column, value });
      return builder;
    },
    order(column: string, opts?: { ascending?: boolean }) {
      orderColumn = column;
      ascending = opts?.ascending !== false;
      return builder;
    },
    limit(count: number) { limitCount = count; return builder; },
    range(from: number, to: number) { rangeFrom = from; rangeTo = to; return builder; },
    async maybeSingle() {
      const { data, error } = run();
      return { data: (data ?? [])[0] ?? null, error };
    },
    then(resolve: (value: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
  };
  return builder;
}

vi.mock("@/lib/supabase-server", () => {
  const client = {
    from: (table: string) => ({
      select: (columns = "*") => selectBuilder(table, columns),
      insert: async () => ({ data: null, error: null }),
      update: () => selectBuilder(table, "*"),
      upsert: async () => ({ data: null, error: null }),
    }),
    auth: {
      admin: {
        getUserById: async () => (db.authUser
          ? { data: { user: { email: db.authUser.email, user_metadata: { full_name: db.authUser.name } } }, error: null }
          : { data: { user: null }, error: { message: "no user" } }),
      },
    },
  };
  return { supabaseAdmin: client, createServerClient: () => client };
});

const granted = vi.hoisted(() => ({ calls: [] as Array<{ userId: string; cents: number }> }));
vi.mock("@/lib/store-credit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store-credit")>();
  return {
    ...actual,
    grantMonthlyStoreCredit: async (userId: string, cents: number) => {
      granted.calls.push({ userId, cents });
      return true;
    },
    reconcileMonthlyStoreCredit: async () => {},
  };
});

vi.mock("@/lib/billing-provider", () => ({ getBillingProvider: () => ({ chargeCard: async () => ({ success: false }) }) }));
vi.mock("@/lib/email/send", () => ({ sendEmail: async () => ({ success: true }) }));
vi.mock("@/lib/email/marketing", () => ({ sendMarketingEmail: async () => ({ success: true }) }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: async () => {} }));

beforeEach(() => {
  db.tables = {};
  db.selectError = {};
  db.authUser = { email: "member@example.test", name: "Member" };
  granted.calls = [];
});

// ---------------------------------------------------------------------------
// ADM-12 — the audit-log filter dropdown must see the WHOLE log.
// ---------------------------------------------------------------------------
describe("ADM-12 — getAuditLogTargetTables reads past the PostgREST row cap", () => {
  it("offers a target table that only appears beyond the first server page", async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 2400; i += 1) {
      rows.push({
        id: `audit-${String(i).padStart(6, "0")}`,
        action: "order_refunded",
        // Everything a single capped response can reach says "orders". The one
        // other table is only visible to a reader that pages.
        target_table: i < 2000 ? "orders" : "coupons",
        target_id: `t-${i}`,
        metadata: {},
        created_at: new Date(Date.now() - i * 1000).toISOString(),
      });
    }
    db.tables.admin_audit_logs = rows;

    const { getAuditLogTargetTables } = await import("@/lib/admin-audit-log");
    expect(await getAuditLogTargetTables()).toEqual(["coupons", "orders"]);
  });

  it("excludes the settings-save action, as the viewer does", async () => {
    db.tables.admin_audit_logs = [
      { id: "a-1", action: "admin_control_upsert", target_table: "email", target_id: "smtp_host" },
      { id: "a-2", action: "order_refunded", target_table: "orders", target_id: "o-1" },
    ];
    const { getAuditLogTargetTables } = await import("@/lib/admin-audit-log");
    expect(await getAuditLogTargetTables()).toEqual(["orders"]);
  });
});

// ---------------------------------------------------------------------------
// MPC-04 — the store-credit sweep must ask the same question the perks do.
// ---------------------------------------------------------------------------
// Four more blocks lived here — MPC-04 (the monthly store-credit grant window),
// MPC-05 (signup refusing a withdrawn tier), DUP-10 (one hand-rolled membership
// order insert) and F6 (the intro-offer admin panel). All four tested
// membership-billing.ts or admin-membership-client.tsx, removed with the paid
// membership feature on 2026-09-12.

describe("CFG-15 — the sweep comment names the settings section that actually holds the key", () => {
  it("cites ambassador.commission_hold_days, not referral.", () => {
    const sweep = readSource("app/api/cron/sweep/route.ts");
    const settings = readSource("lib/ambassador-settings.ts");

    // The key lives in the "ambassador" section (ambassador-settings.ts), and
    // an operator who goes looking under "referral" finds nothing.
    expect(settings).toContain('const SECTION = "ambassador";');
    expect(sweep).toContain("ambassador.commission_hold_days");
    expect(sweep).not.toContain("referral.commission_hold_days");
  });
});
