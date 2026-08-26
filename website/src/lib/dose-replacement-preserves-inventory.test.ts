import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// D-04 — SAVING A PRODUCT EDIT DISARMS ITS OVERSELL PROTECTION.
//
// replaceProductDoses() deleted every dose row and re-inserted from the payload.
// But DoseInput has no field for track_inventory, reserved_quantity,
// incoming_quantity, low_stock_threshold or shipping_weight_oz — those are
// server-side operational state that the admin editor never sends and cannot
// send. Re-inserting therefore reset all five to their schema defaults.
//
// The consequences, all silent, from one ordinary "Save" in the product editor:
//
//   - track_inventory flips to false, so reserve_inventory stops holding stock
//     and the dose can be oversold without limit
//   - reserved_quantity resets to 0, discarding live holds on in-flight
//     checkouts while their inventory_reservations rows stay 'active'
//   - shipping_weight_oz is lost, so the parcel is quoted at the fallback weight
//   - if the payload omits an id, a NEW uuid is minted and every order_items
//     "slug::doseId" and every reservation pointing at the old one is orphaned
//
// And the delete is not transactional with the insert: a failure in between
// leaves the product with zero doses.
// ---------------------------------------------------------------------------

interface DoseRow {
  id: string;
  product_id: string;
  label: string;
  slug_suffix: string;
  price_cents: number;
  inventory_quantity: number;
  track_inventory: boolean;
  reserved_quantity: number;
  incoming_quantity: number;
  low_stock_threshold: number | null;
  shipping_weight_oz: number | null;
  is_default: boolean;
  is_enabled: boolean;
  position: number;
  [key: string]: unknown;
}

const PRODUCT_ID = "prod-dose-0001";
const DOSE_ID = "dose-5mg-0001";

const state: { doses: DoseRow[]; insertFails: boolean } = { doses: [], insertFails: false };

function seedDose(): DoseRow {
  return {
    id: DOSE_ID,
    product_id: PRODUCT_ID,
    label: "5mg",
    slug_suffix: "5mg",
    price_cents: 6000,
    inventory_quantity: 40,
    // The operational state that must survive an edit.
    track_inventory: true,
    reserved_quantity: 2,
    incoming_quantity: 25,
    low_stock_threshold: 20,
    shipping_weight_oz: 3,
    is_default: true,
    is_enabled: true,
    position: 0,
  };
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: vi.fn() }));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "product_doses") {
      return {
        select: () => {
          const b: Record<string, unknown> = {
            eq() { return b; },
            order() { return b; },
            limit() { return b; },
            async maybeSingle() { return { data: state.doses[0] ?? null, error: null }; },
            then(resolve: (v: { data: unknown; error: null }) => unknown) {
              return Promise.resolve({ data: [...state.doses], error: null }).then(resolve);
            },
          };
          return b;
        },
        insert: async (rows: DoseRow[] | DoseRow) => {
          if (state.insertFails) return { error: { message: "insert exploded" } };
          for (const r of Array.isArray(rows) ? rows : [rows]) state.doses.push(r as DoseRow);
          return { error: null };
        },
        upsert: async (rows: DoseRow[] | DoseRow) => {
          if (state.insertFails) return { error: { message: "upsert exploded" } };
          for (const r of Array.isArray(rows) ? rows : [rows]) {
            const at = state.doses.findIndex((d) => d.id === r.id);
            if (at >= 0) state.doses[at] = { ...state.doses[at], ...r };
            else state.doses.push(r as DoseRow);
          }
          return { error: null };
        },
        update: (payload: Record<string, unknown>) => {
          const preds: Record<string, unknown> = {};
          const b: Record<string, unknown> = {
            eq(c: string, v: unknown) { preds[c] = v; return b; },
            in(c: string, v: unknown[]) { preds[c] = v; return b; },
            then(resolve: (x: { error: null }) => unknown) {
              for (const d of state.doses) {
                if (preds.id !== undefined && d.id !== preds.id) continue;
                if (preds.product_id !== undefined && d.product_id !== preds.product_id) continue;
                Object.assign(d, payload);
              }
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return b;
        },
        delete: () => {
          const preds: Record<string, unknown> = {};
          const b: Record<string, unknown> = {
            eq(c: string, v: unknown) { preds[c] = v; return b; },
            in(c: string, v: unknown[]) { preds[c] = v; return b; },
            not(c: string, _op: string, v: unknown) { preds[`not_${c}`] = v; return b; },
            then(resolve: (x: { error: null }) => unknown) {
              state.doses = state.doses.filter((d) => {
                if (preds.product_id !== undefined && d.product_id !== preds.product_id) return true;
                if (Array.isArray(preds.id)) return !(preds.id as unknown[]).includes(d.id);
                return false;
              });
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return b;
        },
      };
    }
    return {
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
      insert: async () => ({ error: null }),
      upsert: async () => ({ error: null }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    };
  };
  return { supabaseAdmin: { from } };
});

async function replace(doses: unknown[]) {
  const { replaceProductDoses } = await import("@/lib/admin-products");
  return replaceProductDoses(PRODUCT_ID, doses as never);
}

// Exactly what the editor round-trips: the customer-facing fields, and the id.
function editorPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: DOSE_ID,
    label: "5mg",
    slugSuffix: "5mg",
    priceCents: 6000,
    inventoryQuantity: 40,
    isDefault: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.doses = [seedDose()];
  state.insertFails = false;
});

describe("saving a product edit", () => {
  it("leaves track_inventory alone — oversell protection must not be switched off by a save", async () => {
    await replace([editorPayload()]);
    const dose = state.doses.find((d) => d.id === DOSE_ID);
    expect(dose?.track_inventory).toBe(true);
  });

  it("does not discard live reservations held against the dose", async () => {
    await replace([editorPayload()]);
    const dose = state.doses.find((d) => d.id === DOSE_ID);
    expect(dose?.reserved_quantity).toBe(2);
  });

  it("keeps incoming stock, the low-stock threshold and the shipping weight", async () => {
    await replace([editorPayload()]);
    const dose = state.doses.find((d) => d.id === DOSE_ID);
    expect(dose?.incoming_quantity).toBe(25);
    expect(dose?.low_stock_threshold).toBe(20);
    expect(dose?.shipping_weight_oz).toBe(3);
  });

  it("still applies the edit the admin actually made", async () => {
    await replace([editorPayload({ priceCents: 7500, label: "5mg (new)" })]);
    const dose = state.doses.find((d) => d.id === DOSE_ID);
    expect(dose?.price_cents).toBe(7500);
    expect(dose?.label).toBe("5mg (new)");
  });

  it("keeps the dose's id, so order_items and reservations pointing at it stay valid", async () => {
    await replace([editorPayload()]);
    expect(state.doses).toHaveLength(1);
    expect(state.doses[0]?.id).toBe(DOSE_ID);
  });

  it("matches an id-less payload to the existing dose by slug rather than minting a new one", async () => {
    // The editor's payload shape is unverified (no caller builds it in src/).
    // If it omits ids, a delete-and-reinsert orphans every reference.
    await replace([{ label: "5mg", slugSuffix: "5mg", priceCents: 6000, inventoryQuantity: 40, isDefault: true }]);
    expect(state.doses).toHaveLength(1);
    expect(state.doses[0]?.id).toBe(DOSE_ID);
    expect(state.doses[0]?.track_inventory).toBe(true);
  });

  it("removes a dose the admin genuinely deleted", async () => {
    state.doses.push({ ...seedDose(), id: "dose-10mg-0002", label: "10mg", slug_suffix: "10mg", is_default: false, position: 1 });
    await replace([editorPayload()]);
    expect(state.doses.map((d) => d.id)).toEqual([DOSE_ID]);
  });

  it("never leaves the product with zero doses when the write fails part-way", async () => {
    // Swap the only 5mg dose for a brand new 10mg one, and make the insert fail.
    // The delete of the old dose must not already have happened, or the product
    // is left with nothing to sell and the storefront falls back to the stale
    // parent row.
    state.insertFails = true;

    await expect(
      replace([{ label: "10mg", slugSuffix: "10mg", priceCents: 9000, inventoryQuantity: 10, isDefault: true }]),
    ).rejects.toBeTruthy();

    expect(state.doses).toHaveLength(1);
    expect(state.doses[0]?.id).toBe(DOSE_ID);
    expect(state.doses[0]?.track_inventory).toBe(true);
  });
});
