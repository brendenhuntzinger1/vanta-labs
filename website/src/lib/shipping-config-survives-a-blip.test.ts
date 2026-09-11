import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A CONTROL-READ BLIP TOLD THE SHOPPER THEY HAD TAMPERED WITH THEIR OWN TOTAL.
//
// getShippingConfig() swallowed any failure of the settings read and answered
// with the coded default, whose freeShippingSitewide is FALSE — correct as a
// first-run default ("the threshold is the store's standing rule until an admin
// deliberately switches this on") and the exact opposite of the live value
// while the switch is ON, which it is in this store.
//
// The cost of that inversion is not a mispriced order. The cart preview is
// built from a separate, earlier read of the same setting, and its total is
// posted back as `expectedTotal`, which quote-order treats as a hard floor:
//
//     if (input.expectedTotal !== undefined
//         && Number(input.expectedTotal) < expectedTotal - 0.01) {
//       throw new Error("Altered total detected");
//     }
//
// So a blip at pay time re-prices the order WITH shipping, the shopper's honest
// total is now below the server's, and the store answers an anti-tamper message
// for a failure entirely inside itself — on the checkout it has already taken
// the customer through.
//
// Last-known-good is the value this process most recently proved. A cold
// process that has never read successfully still gets the coded default.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({ fail: false, sitewide: true }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => {
  // Enough of the builder for readControlRows: it tries the view first and
  // falls back to admin_audit_logs, and both are awaited directly.
  // One row per KEY, with the value under metadata.value — the shape
  // getControlSnapshot reads.
  const rows = () => [
    { id: "r1", target_table: "shipping", target_id: "free_shipping_sitewide", metadata: { value: state.sitewide }, created_at: new Date().toISOString() },
    { id: "r2", target_table: "shipping", target_id: "flat_rate", metadata: { value: 23 }, created_at: new Date().toISOString() },
  ];
  const builder = () => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      order: () => b,
      limit: () => b,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(
        state.fail
          ? { data: null, error: { message: "connection reset" } }
          : { data: rows(), error: null },
      ).then(resolve),
    };
    return b;
  };
  return { supabaseAdmin: { from: () => builder() } };
});

beforeEach(() => {
  vi.resetModules();
  state.fail = false;
  state.sitewide = true;
});

describe("when the control read fails", () => {
  it("keeps the setting it last proved, rather than inverting it", async () => {
    const { getShippingConfig } = await import("@/lib/admin-control");

    const healthy = await getShippingConfig();
    expect(healthy.freeShippingSitewide, "the live store value").toBe(true);

    state.fail = true;
    const duringBlip = await getShippingConfig();

    expect(
      duringBlip.freeShippingSitewide,
      "a blip must not start charging shipping the cart already priced at zero",
    ).toBe(true);
  });

  it("keeps the fees it last proved too, not only the switch", async () => {
    const { getShippingConfig } = await import("@/lib/admin-control");
    const healthy = await getShippingConfig();
    state.fail = true;
    expect((await getShippingConfig()).domesticFee).toBe(healthy.domesticFee);
  });

  it("falls back to the coded default on a cold process that has never read one", async () => {
    // Nothing has been proved yet, so there is nothing to remember. This is the
    // pre-existing behaviour and it stays: a first-run store has no stored
    // setting either.
    state.fail = true;
    const { getShippingConfig } = await import("@/lib/admin-control");
    const { DEFAULT_SHIPPING_CONFIG } = await import("@/lib/shipping");

    expect(await getShippingConfig()).toEqual(DEFAULT_SHIPPING_CONFIG);
  });

  it("follows the setting back down once the read recovers", async () => {
    // Last-known-good is a fallback, never a latch: an admin switching the
    // programme off must take effect on the next successful read. The admin's
    // save clears the ten-second read cache on its way through
    // upsertControlValue; this test writes around that path, so it clears the
    // cache the same way the save would.
    const { getShippingConfig, invalidateControlSnapshotCache } = await import("@/lib/admin-control");
    await getShippingConfig();

    state.sitewide = false;
    invalidateControlSnapshotCache();
    expect((await getShippingConfig()).freeShippingSitewide).toBe(false);
  });
});
