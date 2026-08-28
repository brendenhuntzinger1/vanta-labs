import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// PHASE 11, BUCKET 4 — regressions for the polish findings fixed in this batch.
//
// Three of them are behavioural and get real tests against a fake PostgREST
// (ADM-12, MPC-04, MPC-05). Three are not reachable from a unit test at all —
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
vi.mock("@/lib/veyra-membership", () => ({
  startVeyraMembership: async () => ({ ok: false }),
  cancelVeyraMembership: async () => ({ ok: true }),
  skipVeyraMembershipCycle: async () => ({ ok: true }),
  updateVeyraMembershipCard: async () => ({ ok: true }),
  changeVeyraMembershipPlan: async () => ({ ok: true }),
}));
vi.mock("@/lib/email/send", () => ({ sendEmail: async () => ({ success: true }) }));
vi.mock("@/lib/email/marketing", () => ({ sendMarketingEmail: async () => ({ success: true }) }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: async () => {} }));

const DAY = 24 * 60 * 60 * 1000;

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
describe("MPC-04 — monthly store credit stops when the paid period has clearly ended", () => {
  beforeEach(() => {
    db.tables.membership_tiers = [
      { id: "tier-pro", slug: "pro", name: "Pro", monthly_store_credit_cents: 5000 },
    ];
    db.tables.store_credit_ledger = [];
  });

  it("grants to a member whose period is still running", async () => {
    db.tables.customer_memberships = [
      { user_id: "user-current", tier_id: "tier-pro", status: "active", next_billing_at: new Date(Date.now() + 20 * DAY).toISOString() },
    ];
    const { grantMonthlyStoreCreditSweep } = await import("@/lib/membership-billing");
    const result = await grantMonthlyStoreCreditSweep();

    expect(granted.calls).toEqual([{ userId: "user-current", cents: 5000 }]);
    expect(result.granted).toBe(1);
  });

  it("does NOT grant to a member whose period ended long ago, even though status is still 'active'", async () => {
    db.tables.customer_memberships = [
      // The billing sweep never flipped this row: Veyra owns it, or the cron
      // stalled. isMembershipActive — and therefore every benefit surface —
      // already treats this member as lapsed.
      { user_id: "user-lapsed", tier_id: "tier-pro", status: "active", next_billing_at: new Date(Date.now() - 90 * DAY).toISOString() },
    ];
    const { grantMonthlyStoreCreditSweep } = await import("@/lib/membership-billing");
    const result = await grantMonthlyStoreCreditSweep();

    expect(granted.calls).toEqual([]);
    expect(result.granted).toBe(0);
  });

  it("still grants inside the expiry grace window", async () => {
    db.tables.customer_memberships = [
      { user_id: "user-grace", tier_id: "tier-pro", status: "active", next_billing_at: new Date(Date.now() - 1 * DAY).toISOString() },
    ];
    const { grantMonthlyStoreCreditSweep } = await import("@/lib/membership-billing");
    await grantMonthlyStoreCreditSweep();

    expect(granted.calls.map((call) => call.userId)).toEqual(["user-grace"]);
  });
});

// ---------------------------------------------------------------------------
// MPC-05 — a withdrawn tier must not be purchasable through the API.
// ---------------------------------------------------------------------------
describe("MPC-05 — startMembershipSignup refuses a tier the operator withdrew", () => {
  function seedTier(isActive: boolean | undefined) {
    db.tables.membership_tiers = [
      {
        id: "tier-pro",
        slug: "pro",
        name: "Pro",
        monthly_price_cents: 2900,
        annual_price_cents: 29000,
        intro_price_cents: 0,
        intro_duration_days: 0,
        intro_offer_enabled: false,
        monthly_store_credit_cents: 5000,
        ...(isActive === undefined ? {} : { is_active: isActive }),
      },
    ];
    // Anything reached AFTER the guard fails loudly, so "past the guard" is
    // observable rather than inferred from the absence of a throw.
    db.selectError.customer_memberships = { message: "sentinel: reached the membership lookup" };
  }

  const signup = async (tierId = "tier-pro") => {
    const { startMembershipSignup } = await import("@/lib/membership-billing");
    return startMembershipSignup({ userId: "user-1", tierId, billingCycle: "monthly", tokenIntentId: "ti_live" });
  };

  it("rejects a purchase on an is_active = false tier", async () => {
    seedTier(false);
    await expect(signup()).rejects.toThrow("That membership plan is no longer available.");
  });

  it("allows a purchase on an active tier", async () => {
    seedTier(true);
    await expect(signup()).rejects.toThrow("sentinel: reached the membership lookup");
  });

  it("allows a purchase when the column is absent, so a pre-migration row still sells", async () => {
    seedTier(undefined);
    await expect(signup()).rejects.toThrow("sentinel: reached the membership lookup");
  });
});

// ---------------------------------------------------------------------------
// Source-level regressions for the three findings a unit test cannot reach.
// ---------------------------------------------------------------------------
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

describe("DUP-10 — one hand-rolled membership order insert, not two", () => {
  const source = () => readSource("lib/membership-billing.ts");

  it("no longer defines the caller-less manual annual order builder", () => {
    expect(source()).not.toContain("export async function createAnnualMembershipManualOrder");
  });

  it("writes the orders table from exactly one place in this module", () => {
    const inserts = source().match(/from\("orders"\)\s*\.insert\(/g) ?? [];
    expect(inserts).toHaveLength(1);
  });
});

describe("F6 — the admin console cannot switch on an intro offer that does not exist", () => {
  const source = () => readSource("components/admin-membership-client.tsx");

  it("has no save handler for any intro field", () => {
    const admin = source();
    for (const field of ["introOfferEnabled", "introPriceCents", "introDurationDays"]) {
      expect(admin).not.toMatch(new RegExp(`saveTier\\(tier, \\{ ${field}`));
    }
  });

  it("keeps member discount editable — it is live, and shares the same panel", () => {
    expect(source()).toContain("saveTier(tier, { memberDiscountPercent:");
  });

  it("nothing in the app writes the (status, intro_status) pair the dead sweep steps select", () => {
    // The annotation on those two steps claims they are unreachable. This is
    // the claim: if an intro flow is ever restored, this fails and the comment
    // has to be revisited rather than quietly becoming a lie.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
        const text = readFileSync(full, "utf8");
        if (/status:\s*"trialing"/.test(text) || /intro_status:\s*"active"/.test(text)) {
          offenders.push(path.relative(SRC, full));
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
