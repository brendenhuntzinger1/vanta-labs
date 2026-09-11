import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// ONE CONTROL READ PER INSTANCE PER TEN SECONDS, NOT ONE PER GETTER PER CALL.
//
// Every storefront page load asks /api/catalog/promotions, and that route
// asked the database for the control snapshot FOUR separate times — homepage,
// shipping, referral, coupons — on top of what welcome-offer, bulk-savings and
// payment-methods asked for beside it. On 2026-09-10 `admin_control_current`
// was the second most-read table on the project (3,697 reads in a day), and
// the same day the Supabase edge began timing out queued reads at cron ticks.
//
// The values change when an operator saves in Admin → Control, which is a few
// times a week. Reading them a few thousand times a day is not caution, it is
// load. So readControlRows keeps each section for a short while per instance,
// and a save throws the lot away, so the operator who just clicked Save reads
// their own change back immediately.
// ---------------------------------------------------------------------------

const state: {
  rows: Array<Record<string, unknown>>;
  failReads: boolean;
  readsByTable: Record<string, number>;
} = { rows: [], failReads: false, readsByTable: {} };

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const b: Record<string, unknown> = {
      select() { return b; },
      eq(c: string, v: unknown) { filters.push([c, v]); return b; },
      order() { return b; },
      limit() { return b; },
      lt() { return b; },
      // What upsertControlValue writes; the "view" below serves it back newest
      // first, which is what admin_control_current's DISTINCT ON amounts to.
      insert: async (row: Record<string, unknown>) => {
        state.rows.unshift({ id: `row-${state.rows.length}`, ...row });
        return { error: null };
      },
      then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
        state.readsByTable[table] = (state.readsByTable[table] ?? 0) + 1;
        if (state.failReads) {
          return Promise.resolve({ data: null, error: { message: "Gateway Timeout" } }).then(resolve);
        }
        const rows = state.rows.filter((r) =>
          filters.every(([c, v]) => (c === "action" ? true : r[c] === v)),
        );
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return b;
  };
  return { supabaseAdmin: { from } };
});

function control(section: string, key: string, value: unknown) {
  return {
    id: `${section}-${key}`,
    target_table: section,
    target_id: key,
    metadata: { value },
    created_at: new Date().toISOString(),
  };
}

const VIEW = "admin_control_current";
const viewReads = () => state.readsByTable[VIEW] ?? 0;

async function mod() {
  return import("@/lib/admin-control");
}

beforeEach(async () => {
  state.rows = [
    control("shipping", "free_shipping_threshold_cents", 15000),
    control("referral", "enabled", true),
  ];
  state.failReads = false;
  state.readsByTable = {};
  (await mod()).invalidateControlSnapshotCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the control snapshot cache", () => {
  it("reads a section from the database once and serves it again from memory inside the TTL", async () => {
    const { getControlSnapshot } = await mod();

    const first = await getControlSnapshot("shipping");
    const second = await getControlSnapshot("shipping");

    expect(first.shipping.free_shipping_threshold_cents).toBe(15000);
    expect(second).toEqual(first);
    expect(viewReads()).toBe(1);
  });

  it("asks the database again once the TTL has passed", async () => {
    vi.useFakeTimers();
    const { getControlSnapshot, CONTROL_SNAPSHOT_TTL_MS } = await mod();

    await getControlSnapshot("shipping");
    vi.advanceTimersByTime(CONTROL_SNAPSHOT_TTL_MS + 1);
    await getControlSnapshot("shipping");

    expect(viewReads()).toBe(2);
  });

  it("keeps sections apart, so reading one does not pretend to know another", async () => {
    const { getControlSnapshot } = await mod();

    await getControlSnapshot("shipping");
    const referral = await getControlSnapshot("referral");

    expect(referral.referral.enabled).toBe(true);
    expect(viewReads()).toBe(2);
  });

  it("forgets everything the moment an operator saves, so they read their own change back", async () => {
    const { getControlSnapshot, upsertControlValue } = await mod();

    await getControlSnapshot("shipping");
    await upsertControlValue({ section: "shipping", key: "free_shipping_threshold_cents", value: 9900 });
    const after = await getControlSnapshot("shipping");

    expect(after.shipping.free_shipping_threshold_cents).toBe(9900);
    expect(viewReads()).toBe(2);
  });

  it("lets a caller insist on a fresh read", async () => {
    // The admin control centre itself: an operator on one instance must never
    // be shown another instance's ten-second-old picture of what they saved.
    const { getControlSnapshot } = await mod();

    await getControlSnapshot("shipping");
    await getControlSnapshot("shipping", { fresh: true });

    expect(viewReads()).toBe(2);
  });

  it("never caches a failed read", async () => {
    // A gateway timeout must not be remembered as "there are no settings" for
    // the next ten seconds of checkouts.
    const { getControlSnapshot } = await mod();

    state.failReads = true;
    await expect(getControlSnapshot("shipping")).rejects.toBeTruthy();

    state.failReads = false;
    const recovered = await getControlSnapshot("shipping");
    expect(recovered.shipping.free_shipping_threshold_cents).toBe(15000);
  });
});
