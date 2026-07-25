import { describe, it, expect } from "vitest";
import { InventoryReservationModel } from "@/lib/inventory-reservation-model";

// These lock the reservation state machine's core guarantee — stock can never
// be oversold and is always conserved across reserve → finalize/release/expire.
// The production atomicity is enforced by Postgres row locks; this models the
// same indivisible reserve so we can fan out hundreds of concurrent checkouts.

describe("inventory reservation — no oversell under heavy concurrency", () => {
  it("N units vs 500 simultaneous buyers → exactly N win, stock ends at 0, never negative", async () => {
    for (const stock of [1, 2, 3, 10, 47]) {
      const model = new InventoryReservationModel();
      model.setStock("SKU", stock);
      const buyers = 500;
      let won = 0;

      await Promise.all(
        Array.from({ length: buyers }, (_, i) => (async () => {
          await Promise.resolve(); // yield to interleave scheduling
          const held = model.reserve(`order-${i}`, "SKU", 1, Date.now() + 900_000);
          if (held && model.reservedOf("SKU") <= stock) {
            model.finalize(`order-${i}`); // simulate a verified payment
            won += 1;
          }
        })()),
      );

      expect(won).toBe(stock);
      expect(model.inventoryOf("SKU")).toBe(0);
      expect(model.reservedOf("SKU")).toBe(0);
      expect(model.available("SKU")).toBeGreaterThanOrEqual(0);
    }
  });

  it("abandoned checkouts release their hold so the units become buyable again", () => {
    const model = new InventoryReservationModel();
    model.setStock("SKU", 1);

    expect(model.reserve("order-A", "SKU", 1, Date.now() + 900_000)).toBe(true);
    // The single unit is now held — a second buyer is correctly blocked.
    expect(model.reserve("order-B", "SKU", 1, Date.now() + 900_000)).toBe(false);

    // Buyer A abandons → release returns the unit.
    expect(model.release("order-A")).toBe(1);
    expect(model.available("SKU")).toBe(1);

    // Buyer B can now buy it, and payment permanently deducts it.
    expect(model.reserve("order-B", "SKU", 1, Date.now() + 900_000)).toBe(true);
    model.finalize("order-B");
    expect(model.inventoryOf("SKU")).toBe(0);
    expect(model.reservedOf("SKU")).toBe(0);
  });

  it("a hold expires after its window and the unit is reclaimed", () => {
    const model = new InventoryReservationModel();
    model.setStock("SKU", 1);
    const t0 = 1_000_000;
    expect(model.reserve("order-A", "SKU", 1, t0 + 15 * 60_000)).toBe(true);
    expect(model.available("SKU")).toBe(0);

    // 16 minutes later the sweep runs.
    expect(model.expire(t0 + 16 * 60_000)).toBe(1);
    expect(model.available("SKU")).toBe(1);
    // A fresh buyer gets it.
    expect(model.reserve("order-B", "SKU", 1, t0 + 16 * 60_000 + 900_000)).toBe(true);
  });

  it("a page refresh / duplicate request never double-holds or extends the same order line", () => {
    const model = new InventoryReservationModel();
    model.setStock("SKU", 5);
    for (let i = 0; i < 20; i++) {
      expect(model.reserve("order-A", "SKU", 2, Date.now() + 900_000)).toBe(true);
    }
    // 20 identical requests still only hold 2 units, not 40.
    expect(model.reservedOf("SKU")).toBe(2);
    expect(model.available("SKU")).toBe(3);
  });

  it("finalize and release are idempotent (replayed webhooks can't double-move stock)", () => {
    const model = new InventoryReservationModel();
    model.setStock("SKU", 3);
    model.reserve("order-A", "SKU", 2, Date.now() + 900_000);

    expect(model.finalize("order-A")).toBe(1);
    expect(model.finalize("order-A")).toBe(0); // replay: nothing left active
    expect(model.inventoryOf("SKU")).toBe(1);
    expect(model.reservedOf("SKU")).toBe(0);

    expect(model.release("order-A")).toBe(0); // already finalized → no-op
    expect(model.inventoryOf("SKU")).toBe(1);
  });

  it("an untracked (3PL-authority) item is never blocked, no matter how many buyers", async () => {
    const model = new InventoryReservationModel();
    // Never call setStock → the SKU is untracked (3PL-authority catalog).
    let won = 0;
    await Promise.all(
      Array.from({ length: 300 }, (_, i) => (async () => {
        await Promise.resolve();
        if (model.reserve(`order-${i}`, "SKU", 1, Date.now() + 900_000)) won += 1;
      })()),
    );
    expect(won).toBe(300); // every purchase allowed
    expect(model.reservedOf("SKU")).toBe(0); // nothing held for untracked stock
  });

  it("mixed multi-line orders never oversell any single SKU", async () => {
    const model = new InventoryReservationModel();
    model.setStock("A", 5);
    model.setStock("B", 3);
    let aWon = 0;
    let bWon = 0;
    await Promise.all(
      Array.from({ length: 200 }, (_, i) => (async () => {
        await Promise.resolve();
        const okA = model.reserve(`order-${i}`, "A", 1, Date.now() + 900_000);
        const okB = model.reserve(`order-${i}`, "B", 1, Date.now() + 900_000);
        if (okA && okB) {
          model.finalize(`order-${i}`);
          aWon += 1;
          bWon += 1;
        } else {
          model.release(`order-${i}`); // couldn't get both → give back the partial
        }
      })()),
    );
    // Bottlenecked by B (3 units); neither SKU is oversold.
    expect(bWon).toBe(3);
    expect(aWon).toBe(3);
    expect(model.inventoryOf("A")).toBe(2);
    expect(model.inventoryOf("B")).toBe(0);
    expect(model.reservedOf("A")).toBe(0);
    expect(model.reservedOf("B")).toBe(0);
  });
});
