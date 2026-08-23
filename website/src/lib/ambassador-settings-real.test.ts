import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE THREE NUMBERS THAT DECIDE WHEN AN AMBASSADOR GETS PAID.
//
// minimumQualifyingOrder  -- how big an order must be to earn commission
// minimumPayoutThreshold  -- how much must accrue before a payout is owed
// commissionHoldDays      -- how long earnings are held before becoming payable
//
// Globally mocked with fixed literals, so the real reader had never run. A
// wrong value here either pays commission that was not earned or withholds
// commission that was.
//
// The subtlety this module gets right, and which the tests pin: a stored ZERO
// is a real decision ("no minimum"), not an empty field. Reading it as "never
// saved" would silently reimpose a default the owner deliberately removed.
// ---------------------------------------------------------------------------

vi.unmock("@/lib/ambassador-settings");

const state: { rows: Array<Record<string, unknown>>; failRead: boolean } = { rows: [], failRead: false };

vi.mock("server-only", () => ({}));

// getControlSnapshot comes from @/lib/admin-control, which the suite-wide
// setup replaces. Stub just that one reader so this file drives the REAL
// ambassador-settings parsing against controlled input.
vi.mock("@/lib/admin-control", () => ({
  getControlSnapshot: async () => {
    if (state.failRead) throw new Error("control table unreadable");
    const section: Record<string, unknown> = {};
    for (const row of state.rows) {
      section[String(row.target_id)] = (row.metadata as { value?: unknown })?.value ?? null;
    }
    return { ambassador: section };
  },
  upsertControlValue: async () => {},
}));

vi.mock("@/lib/supabase-server", () => {
  const from = () => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      order: () => b,
      limit: () => b,
      insert: async () => ({ error: null }),
      then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
        if (state.failRead) return Promise.resolve({ data: null, error: { message: "down" } }).then(resolve);
        return Promise.resolve({ data: state.rows, error: null }).then(resolve);
      },
    };
    return b;
  };
  return { supabaseAdmin: { from } };
});

function control(key: string, value: unknown) {
  return {
    id: key,
    target_table: "ambassador",
    target_id: key,
    metadata: { value },
    created_at: new Date().toISOString(),
  };
}

async function settings() {
  const { getAmbassadorProgramSettings } = await import("@/lib/ambassador-settings");
  return getAmbassadorProgramSettings();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  state.rows = [];
  state.failRead = false;
});

describe("when nothing has been configured", () => {
  it("returns finite, non-negative defaults rather than NaN", async () => {
    const s = await settings();
    for (const [name, value] of Object.entries({
      minimumQualifyingOrder: s.minimumQualifyingOrder,
      minimumPayoutThreshold: s.minimumPayoutThreshold,
      commissionHoldDays: s.commissionHoldDays,
    })) {
      expect(Number.isFinite(value), `${name} must be a real number`).toBe(true);
      expect(value, `${name} must not be negative`).toBeGreaterThanOrEqual(0);
    }
  });

  it("reports each value as NOT stored, so the admin can show it is a default", async () => {
    const s = await settings();
    expect(s.stored.minimumQualifyingOrder).toBe(false);
    expect(s.stored.minimumPayoutThreshold).toBe(false);
    expect(s.stored.commissionHoldDays).toBe(false);
  });
});

describe("a configured value", () => {
  it("is used", async () => {
    state.rows = [control("minimum_qualifying_order", 250)];
    const s = await settings();
    expect(s.minimumQualifyingOrder).toBe(250);
    expect(s.stored.minimumQualifyingOrder).toBe(true);
  });

  it("treats a stored ZERO as a real decision, not an empty field", async () => {
    // "No minimum order" is a legitimate choice. Reading 0 as unset would
    // silently reimpose a minimum the owner deliberately removed, and quietly
    // stop paying commission on small orders.
    state.rows = [control("minimum_qualifying_order", 0)];
    const s = await settings();
    expect(s.minimumQualifyingOrder).toBe(0);
    expect(s.stored.minimumQualifyingOrder).toBe(true);
  });

  it("treats a stored zero hold period as immediate payability", async () => {
    state.rows = [control("commission_hold_days", 0)];
    const s = await settings();
    expect(s.commissionHoldDays).toBe(0);
    expect(s.stored.commissionHoldDays).toBe(true);
  });
});

describe("a value that cannot be a real setting", () => {
  const hostile: Array<[string, unknown]> = [
    ["a negative amount", -50],
    ["a non-numeric string", "lots"],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["an object", { amount: 100 }],
  ];

  // Checked on EVERY setting: each has its own guard, so proving one leaves
  // the other two unproven.
  const KEYS: Array<[string, keyof Awaited<ReturnType<typeof settings>>]> = [
    ["minimum_qualifying_order", "minimumQualifyingOrder"],
    ["minimum_payout_threshold", "minimumPayoutThreshold"],
    ["commission_hold_days", "commissionHoldDays"],
  ];

  for (const [storedKey, field] of KEYS) {
    for (const [label, value] of hostile) {
      it(`${String(field)} falls back to the default for ${label}`, async () => {
        state.rows = [control(storedKey, value)];
        const withBad = await settings();

        vi.resetModules();
        state.rows = [];
        const withNothing = await settings();

        expect(withBad[field]).toBe(withNothing[field]);
        expect(Number.isFinite(withBad[field] as number)).toBe(true);
        expect(withBad[field] as number).toBeGreaterThanOrEqual(0);
      });
    }
  }
});

describe("when the control table cannot be read", () => {
  it("returns defaults rather than throwing", async () => {
    // These settings are read while creating a commission on a paid order.
    // Throwing here would fail the payment side-effects.
    state.failRead = true;
    const s = await settings();
    expect(Number.isFinite(s.minimumQualifyingOrder)).toBe(true);
    expect(Number.isFinite(s.minimumPayoutThreshold)).toBe(true);
    expect(Number.isFinite(s.commissionHoldDays)).toBe(true);
  });

  it("does not claim the values were stored", async () => {
    state.failRead = true;
    const s = await settings();
    expect(s.stored.minimumQualifyingOrder).toBe(false);
  });
});
