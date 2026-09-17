import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WHICH WAY THE LEDGER FAILS, AND FOR WHOM.
 *
 * The claim is an insert, and what it answers when the insert fails for any
 * reason other than a duplicate key is a choice the caller has to make:
 *
 *   * an EVENT fails OPEN. Losing "paid for order" to a ledger outage costs a
 *     post-purchase flow; a rare duplicate costs nothing, because Omnisend
 *     deduplicates historical events on eventID.
 *   * a MINT fails CLOSED. The cart-offer sweep takes its once-per-cart claim
 *     before minting a discount code and a gift, and there is no upstream
 *     dedup for money: with the ledger unreachable, a fail-open claim would
 *     let every 30-minute tick re-mint for every qualifying cart.
 *
 * Pinned behaviourally, against a mocked table, because the difference is a
 * single boolean and a source pin cannot tell "returns true" from "returns
 * !failClosed".
 */
type InsertOutcome = { error: null } | { error: { code?: string; message?: string } } | "throw";
let insertOutcome: InsertOutcome = { error: null };
let updateOutcome: { data: unknown; error: unknown } | "throw" = { data: [], error: null };
const inserts: unknown[] = [];

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    expect(table).toBe("omnisend_events_sent");
    return {
      insert: async (row: unknown) => {
        inserts.push(row);
        if (insertOutcome === "throw") throw new Error("connection reset");
        return insertOutcome;
      },
      update: () => {
        const chain: Record<string, unknown> = {};
        for (const op of ["eq", "lt"]) chain[op] = () => chain;
        chain.select = async () => {
          if (updateOutcome === "throw") throw new Error("connection reset");
          return updateOutcome;
        };
        return chain;
      },
    };
  };
  return { supabaseAdmin: { from } };
});

import { omnisendLedger } from "@/lib/marketing/omnisend/ledger";

beforeEach(() => {
  insertOutcome = { error: null };
  updateOutcome = { data: [], error: null };
  inserts.length = 0;
});

describe("claimSend", () => {
  it("claims with one insert and answers true when it lands", async () => {
    await expect(omnisendLedger("cart-1").claimSend("recovery offer", "cart-1:recovery offer")).resolves.toBe(true);
    expect(inserts).toEqual([{ entity_id: "cart-1", event_name: "recovery offer", event_id: "cart-1:recovery offer", delivered: false }]);
  });

  it("answers false on a duplicate key, whichever way it is asked to fail", async () => {
    insertOutcome = { error: { code: "23505" } };
    await expect(omnisendLedger("cart-1").claimSend("recovery offer", "x")).resolves.toBe(false);
    await expect(omnisendLedger("cart-1").claimSend("recovery offer", "x", { failClosed: true })).resolves.toBe(false);
    await expect(omnisendLedger("cart-1").claimSend("recovery offer", "x", { failClosed: false })).resolves.toBe(false);
  });

  it("fails OPEN by default on any other refusal or a thrown error: an event is cheaper lost than duplicated", async () => {
    insertOutcome = { error: { code: "42P01", message: "relation does not exist" } };
    await expect(omnisendLedger("order-1").claimSend("paid for order", "order-1:paid for order")).resolves.toBe(true);
    insertOutcome = "throw";
    await expect(omnisendLedger("order-1").claimSend("paid for order", "order-1:paid for order")).resolves.toBe(true);
  });

  it("fails CLOSED when asked, on the same refusal and the same thrown error: a mint must never repeat", async () => {
    insertOutcome = { error: { code: "42P01", message: "relation does not exist" } };
    await expect(omnisendLedger("cart-1").claimSend("recovery offer", "cart-1:recovery offer", { failClosed: true })).resolves.toBe(false);
    insertOutcome = "throw";
    await expect(omnisendLedger("cart-1").claimSend("recovery offer", "cart-1:recovery offer", { failClosed: true })).resolves.toBe(false);
  });
});

describe("claimSendWithin", () => {
  it("still fails OPEN on a ledger error: the cart and view events keep the event contract", async () => {
    insertOutcome = { error: { code: "23505" } };
    updateOutcome = { data: null, error: { message: "permission denied" } };
    await expect(omnisendLedger("cart-1").claimSendWithin("added product to cart", "x", 600_000)).resolves.toBe(true);
    updateOutcome = "throw";
    await expect(omnisendLedger("cart-1").claimSendWithin("added product to cart", "x", 600_000)).resolves.toBe(true);
  });

  it("refreshes only when the conditional update touched a row", async () => {
    insertOutcome = { error: { code: "23505" } };
    updateOutcome = { data: [{ entity_id: "cart-1" }], error: null };
    await expect(omnisendLedger("cart-1").claimSendWithin("added product to cart", "x", 600_000)).resolves.toBe(true);
    updateOutcome = { data: [], error: null };
    await expect(omnisendLedger("cart-1").claimSendWithin("added product to cart", "x", 600_000)).resolves.toBe(false);
  });
});
