import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// P2-2: NOTHING EVER WROTE `resolved_at`.
//
// Four things read the column — getOpenCriticalAlertCount (the badge in the
// admin layout), /admin/status, shipping-cost-repair's loadBacklog and
// refund-effect-repair's truncationAlreadyReported — and no code path in the
// application wrote it. Production carried 52 alerts, every one of them open,
// because "open" was the only state the table could ever hold. Both sweeps
// carry comments about what happens "the moment a human resolves the row";
// there was no way for a human to resolve a row.
//
// These tests are about the WRITE existing and being correct. The double below
// is PostgREST-shaped over one table and honours the filters the code issues,
// so a resolve that forgets its `is("resolved_at", null)` guard, or a dedup
// that counts resolved rows, fails here rather than in production.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const db: { system_alerts: Row[] } = { system_alerts: [] };

const mocks = vi.hoisted(() => ({ sendEmail: vi.fn(async () => ({ success: true })) }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/send", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@/lib/admin-control", () => ({ getBusinessSettings: async () => ({ supportEmail: "" }) }));
vi.mock("@/lib/sentry-init", () => ({ sentryEnabled: () => false }));

vi.mock("@/lib/supabase-server", () => {
  function builder() {
    const rows = db.system_alerts;
    const filters: Array<(row: Row) => boolean> = [];
    const sortKeys: Array<{ col: string; asc: boolean }> = [];
    let mode: "select" | "update" = "select";
    let counting = false;
    let payload: Row = {};
    let take: number | null = null;

    const hits = () => {
      const out = rows.filter((r) => filters.every((f) => f(r)));
      out.sort((a, b2) => {
        for (const { col, asc } of sortKeys) {
          const cmp = String(a[col] ?? "").localeCompare(String(b2[col] ?? ""));
          if (cmp !== 0) return asc ? cmp : -cmp;
        }
        return 0;
      });
      return take === null ? out : out.slice(0, take);
    };

    const settle = () => {
      if (mode === "update") {
        const matched = hits();
        for (const row of matched) Object.assign(row, payload);
        return { data: matched.map((r) => ({ id: r.id })), error: null };
      }
      if (counting) return { data: null, count: hits().length, error: null };
      return { data: hits().map((r) => ({ ...r })), error: null };
    };

    const b: Record<string, unknown> = {
      insert(row: Row) {
        rows.push({ resolved_at: null, ...row });
        return Promise.resolve({ error: null });
      },
      update(next: Row) { mode = "update"; payload = next; return b; },
      select(_cols?: string, options?: { count?: string; head?: boolean }) {
        // A head:true count still has its filters appended after select(), so
        // the chain has to stay open — resolving here would count the table.
        if (options?.count) counting = true;
        return b;
      },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b; },
      in(c: string, v: unknown[]) { filters.push((r) => v.includes(r[c])); return b; },
      gte(c: string, v: unknown) { filters.push((r) => String(r[c] ?? "") >= String(v)); return b; },
      order(c: string, o?: { ascending?: boolean }) { sortKeys.push({ col: c, asc: o?.ascending !== false }); return b; },
      limit(n: number) { take = n; return Promise.resolve(settle()); },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(settle()).then(resolve); },
    };
    return b;
  }
  return { supabaseAdmin: { from: () => builder() } };
});

const {
  getOpenCriticalAlertCount,
  getOpenSystemAlerts,
  recordSystemAlert,
  resolveSystemAlerts,
} = await import("@/lib/monitoring");

let seq = 0;
function seed(alert: { type: string; severity?: string; resolved_at?: string | null }) {
  seq += 1;
  const id = `alert-${seq}`;
  db.system_alerts.push({
    id,
    type: alert.type,
    severity: alert.severity ?? "warning",
    message: `${alert.type} happened`,
    context: {},
    created_at: `2026-08-27T00:00:${String(seq).padStart(2, "0")}.000Z`,
    resolved_at: alert.resolved_at ?? null,
  });
  return id;
}

beforeEach(() => {
  db.system_alerts = [];
  seq = 0;
  vi.clearAllMocks();
});

describe("resolving an alert", () => {
  it("stamps resolved_at, which nothing in the application did before", async () => {
    const id = seed({ type: "fulfillment_failed", severity: "critical" });

    await resolveSystemAlerts({ ids: [id] });

    expect(db.system_alerts[0].resolved_at).toEqual(expect.any(String));
  });

  it("takes the alert out of the critical badge count", async () => {
    const first = seed({ type: "fulfillment_failed", severity: "critical" });
    seed({ type: "shippo_label_unattributed", severity: "critical" });
    expect(await getOpenCriticalAlertCount()).toBe(2);

    await resolveSystemAlerts({ ids: [first] });

    expect(await getOpenCriticalAlertCount()).toBe(1);
  });

  it("clears a whole storm by type, which is the only humane way to clear 44 rows", async () => {
    for (let i = 0; i < 44; i += 1) seed({ type: "shipping_cost_manual_entry_required" });
    seed({ type: "fulfillment_failed", severity: "critical" });

    const resolved = await resolveSystemAlerts({
      type: "shipping_cost_manual_entry_required", severity: "warning",
    });

    expect(resolved).toBe(44);
    expect((await getOpenSystemAlerts()).map((a) => a.type)).toEqual(["fulfillment_failed"]);
  });

  it("clears repetitions that arrived after the operator loaded the page", async () => {
    // The group is the unit. Pinning the resolve to the ids that happened to be
    // on screen leaves a storm looking half-cleared: the row disappears, then
    // reappears on the next render carrying the two rows that landed while the
    // operator was reading it.
    const onScreen = [seed({ type: "shipping_cost_manual_entry_required" })];
    seed({ type: "shipping_cost_manual_entry_required" });
    seed({ type: "shipping_cost_manual_entry_required" });

    const resolved = await resolveSystemAlerts({
      ids: onScreen,
      type: "shipping_cost_manual_entry_required",
      severity: "warning",
    });

    expect(resolved).toBe(3);
    expect(await getOpenSystemAlerts()).toHaveLength(0);
  });

  it("NEVER lets dismissing a warning clear a critical that shares its type", async () => {
    // /admin/status groups on severity as well as type, so these are two rows
    // on screen. Resolving by type alone would silently take the critical with
    // it — the badge would drop by one with nothing explaining why.
    seed({ type: "cron_sweep_failed", severity: "warning" });
    seed({ type: "cron_sweep_failed", severity: "critical" });

    await resolveSystemAlerts({ type: "cron_sweep_failed", severity: "warning" });

    expect(await getOpenCriticalAlertCount()).toBe(1);
    expect((await getOpenSystemAlerts()).map((a) => a.severity)).toEqual(["critical"]);
  });

  it("never rewrites the timestamp of an alert someone else already resolved", async () => {
    // Guarded on `resolved_at is null`. Without the guard, a second operator
    // pressing the same button overwrites the first one's timestamp — the row
    // then reports when it was clicked again, not when the problem was dealt
    // with.
    const id = seed({ type: "email_undeliverable", resolved_at: "2026-08-01T00:00:00.000Z" });

    const resolved = await resolveSystemAlerts({ ids: [id] });

    expect(resolved).toBe(0);
    expect(db.system_alerts[0].resolved_at).toBe("2026-08-01T00:00:00.000Z");
  });

  it("refuses to touch anything when told to resolve nothing", async () => {
    seed({ type: "fulfillment_failed", severity: "critical" });

    expect(await resolveSystemAlerts({ ids: [] })).toBe(0);
    expect(db.system_alerts[0].resolved_at).toBeNull();
  });
});

describe("the repeat-collapse window", () => {
  it("writes the first alert and suppresses the ones behind it", async () => {
    await recordSystemAlert({
      type: "payment_webhook_error", severity: "warning", message: "one", dedupeWindowMs: 60_000,
    });
    await recordSystemAlert({
      type: "payment_webhook_error", severity: "warning", message: "two", dedupeWindowMs: 60_000,
    });

    expect(db.system_alerts).toHaveLength(1);
  });

  it("does not collapse a DIFFERENT type raised in the same window", async () => {
    await recordSystemAlert({ type: "payment_webhook_error", severity: "warning", message: "a", dedupeWindowMs: 60_000 });
    await recordSystemAlert({ type: "cron_sweep_timeout", severity: "critical", message: "b", dedupeWindowMs: 60_000 });

    expect(db.system_alerts.map((r) => r.type)).toEqual(["payment_webhook_error", "cron_sweep_timeout"]);
  });

  it("reports again as soon as the standing row is resolved", async () => {
    // The dedup counts UNRESOLVED rows only. An operator who clears the alert is
    // saying they dealt with it, so the next occurrence is news again — the same
    // rule refund-effect-repair's truncationAlreadyReported already states.
    await recordSystemAlert({ type: "payment_webhook_error", severity: "warning", message: "a", dedupeWindowMs: 60_000 });
    await resolveSystemAlerts({ type: "payment_webhook_error" });

    await recordSystemAlert({ type: "payment_webhook_error", severity: "warning", message: "b", dedupeWindowMs: 60_000 });

    expect(db.system_alerts.filter((r) => r.resolved_at === null)).toHaveLength(1);
  });

  it("suppresses the operator email too, not just the row", async () => {
    process.env.ALERT_EMAIL = "ops@example.test";
    await recordSystemAlert({ type: "cron_sweep_timeout", severity: "critical", message: "a", dedupeWindowMs: 60_000 });
    await recordSystemAlert({ type: "cron_sweep_timeout", severity: "critical", message: "b", dedupeWindowMs: 60_000 });
    delete process.env.ALERT_EMAIL;

    // A collapsed alert is the same fact already on file. Emailing it again is
    // exactly the 48-a-day flood the window exists to stop.
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("still writes every occurrence when no window is asked for", async () => {
    // Most alerts are EVENTS. Two fulfilment failures are two facts and
    // collapsing them by default would lose one.
    await recordSystemAlert({ type: "fulfillment_failed", severity: "critical", message: "order A" });
    await recordSystemAlert({ type: "fulfillment_failed", severity: "critical", message: "order B" });

    expect(db.system_alerts).toHaveLength(2);
  });
});
