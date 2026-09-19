import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFakeDb } from "@/lib/e2e/fake-db";

// ---------------------------------------------------------------------------
// WHAT HAPPENS TO THE PRIZE WHEN THE WALLET ORDER DOES NOT SURVIVE.
//
// The quote tests next door prove the prize is PRICED the same on both lanes.
// This file is about the other half: the hold. A one-time offer is reserved
// before the order row exists and must be handed back on every path where that
// order then dies — and unlike stock and store credit, it does not simply age
// out of everything. chooseSpinDose guards its write on `reserved_order_id is
// null` and deliberately fails closed on a stale hold, so a prize left reserved
// against an order that will never be paid cannot have its dose changed again,
// and the panel beside the picker says "You can change this until the prize
// expires". That is the cost of missing one branch.
//
// TWO KINDS OF EVIDENCE, AND THE HEADER SAYS WHICH IS WHICH.
//
//   ORDERING AND PAIRING are read off the route source. authorize/route.ts
//   wires twelve server modules and chargeViaVeyra is module-private, so there
//   is no route-level harness (express-authorize-decline-recording.test.ts
//   makes the same call and says so). But the regressions that matter here are
//   POSITIONAL — a reserve that drifts after the insert, a cancel that loses
//   its release — and position is exactly what a source read can hold
//   rigorously. These assert index against index, never mere presence.
//
//   THE HOLD ITSELF is exercised for real, against the fake database's
//   customer_offer_* procedures. Those are what any e2e journey through this
//   lane runs on, so a fake that accepted a second reservation would make the
//   whole lane look correct while proving nothing. The REAL SQL is proved
//   separately against a real Postgres in sql/customer-offers.test.ts; this
//   checks the stand-in agrees with it on the rules the express lane leans on.
// ---------------------------------------------------------------------------

const ROUTE = readFileSync(
  join(process.cwd(), "src", "app", "api", "checkout", "express", "authorize", "route.ts"),
  "utf8",
);

/** The POST body only — the helpers below it have their own `cancelOrder`. */
const POST_BODY = ROUTE.slice(ROUTE.indexOf("export async function POST("), ROUTE.indexOf("async function cancelOrder("));

describe("the hold is taken at the only moment it can be", () => {
  it("reserves AFTER the intent is claimed, so the hold names the order that will exist", () => {
    const claim = POST_BODY.indexOf("const claimed = await claimIntent(sessionId);");
    const reserve = POST_BODY.indexOf("await reserveCustomerOffer({");
    expect(claim, "the intent claim must exist").toBeGreaterThan(-1);
    expect(reserve, "the reservation must exist").toBeGreaterThan(-1);
    expect(reserve, "a hold taken before the claim names an order id that may never be used")
      .toBeGreaterThan(claim);
  });

  it("reserves BEFORE the order row is written, so a refusal leaves nothing to cancel", () => {
    // The card lane states this rule at payment-service.ts:429 and this lane
    // has to follow it: quoteOrder has already put a $0 line in this order from
    // an ADVISORY read that took no lock, so two checkouts holding one token
    // can both have been priced a free vial. The reservation is the only place
    // that is resolved, and it must resolve before anything is committed.
    const reserve = POST_BODY.indexOf("await reserveCustomerOffer({");
    const insert = POST_BODY.indexOf("const insertOutcome = await insertOrderRow(orderRow);");
    expect(insert).toBeGreaterThan(-1);
    expect(reserve, "an order written before the hold can ship a free unit nobody claimed")
      .toBeLessThan(insert);
  });

  it("refuses the whole order when the hold is refused, and charges nothing", () => {
    const reserve = POST_BODY.indexOf("await reserveCustomerOffer({");
    // Wide enough to clear the rationale comment inside the call itself.
    const block = POST_BODY.slice(reserve, reserve + 2200);
    expect(block, "a failed reservation must not fall through").toContain("if (!reserved) {");
    // It ends the intent and returns. Letting it through would ship a free unit
    // without consuming the offer, and the customer could do it again tomorrow.
    expect(block).toContain('"failed"');
    expect(block).toContain("return refuse(");
    // And it happens before the order row exists, so there is nothing to undo.
    expect(POST_BODY.indexOf("const insertOutcome = await insertOrderRow(orderRow);"))
      .toBeGreaterThan(reserve);
  });
});

describe("every path that kills the order hands the prize back", () => {
  /** Offsets of every `await cancelOrder(...)` inside the POST. */
  const cancels = (() => {
    const found: number[] = [];
    let at = POST_BODY.indexOf("await cancelOrder(");
    while (at !== -1) {
      found.push(at);
      at = POST_BODY.indexOf("await cancelOrder(", at + 1);
    }
    return found;
  })();

  it("has failure paths at all, so an empty sweep cannot pass this file", () => {
    // The guard on the guard. If a refactor renamed cancelOrder, every
    // assertion below would iterate an empty list and report success.
    expect(cancels.length, "no cancel paths found — this suite would be vacuous").toBeGreaterThanOrEqual(4);
  });

  it.each([0, 1, 2, 3])("cancel path #%i releases the offer immediately after", (index) => {
    const at = cancels[index];
    expect(at, `cancel path #${index} is missing`).toBeGreaterThan(-1);
    // "Immediately" is the point: the release must not sit behind a branch that
    // some other condition can skip. One short window, checked per site.
    const window = POST_BODY.slice(at, at + 160);
    expect(window, `a cancelled order at offset ${at} leaves the prize held`)
      .toContain("await handBackTheGift();");
  });

  it("releases when the order row itself could not be written", () => {
    // No cancelOrder here — there is no row to cancel — but the hold was taken
    // a few lines above and is just as stuck.
    const insert = POST_BODY.indexOf("const insertOutcome = await insertOrderRow(orderRow);");
    const branch = POST_BODY.slice(insert, POST_BODY.indexOf("const { payload: orderItemsPayload", insert));
    expect(branch).toContain('if (insertOutcome.status !== "inserted") {');
    expect(branch, "a failed insert leaves the prize held").toContain("await handBackTheGift();");
  });

  it("cannot take back a prize that was already redeemed, whatever the caller does", () => {
    // The guarantee is in the SQL, not in this route: customer_offer_release
    // matches on `redeemed_at is null`, so a release fired for an order that
    // later paid matches no row. That is what makes calling it on every failure
    // path safe rather than merely convenient.
    const sql = readFileSync(join(process.cwd(), "src", "lib", "sql", "customer-offers.sql"), "utf8");
    const fn = sql.slice(sql.indexOf("create or replace function public.customer_offer_release"));
    expect(fn.slice(0, 600)).toContain("and redeemed_at is null");
  });

  it("survives its own failure rather than taking the order down with it", () => {
    const helper = POST_BODY.slice(POST_BODY.indexOf("const handBackTheGift = async () => {"));
    expect(helper.slice(0, 400), "a release that throws must not become the customer's error")
      .toContain(".catch(");
  });
});

describe("a dead express session releases what it retired", () => {
  it("reconcile hands the offer back beside the stock", () => {
    // The sweep that retires an order whose session died is the one path no
    // request is on, so nothing else can release for it.
    const reconcile = readFileSync(join(process.cwd(), "src", "lib", "express-reconcile.ts"), "utf8");
    const at = reconcile.indexOf("await releaseInventoryForOrder(order.order_id);");
    expect(at, "the sweep must release stock").toBeGreaterThan(-1);
    // Wide enough to clear the paragraph explaining why the gift goes too.
    expect(reconcile.slice(at, at + 1200), "stock came back and the prize did not")
      .toContain("releaseCustomerOffer(order.order_id)");
  });
});

// ---------------------------------------------------------------------------
// The stand-in database, checked against the rules the lane leans on.
// ---------------------------------------------------------------------------
describe("the fake database's offer hold behaves like the real one", () => {
  const TOKEN_HASH = "hash-of-one-token";
  const EMAIL = "winner@example.test";

  function dbWithOffer(overrides: Record<string, unknown> = {}) {
    const db = createFakeDb();
    db.seed("customer_offers", [{
      id: "offer-1",
      offer_key: "spin:winback_2026q4",
      token_hash: TOKEN_HASH,
      email: EMAIL,
      reward_kind: "free_product",
      product_slug: "ghk-cu",
      min_subtotal_cents: 7500,
      expires_at: new Date(Date.now() + 72 * 3600_000).toISOString(),
      reserved_order_id: null,
      reserved_at: null,
      redeemed_order_id: null,
      redeemed_at: null,
      revoked_at: null,
      ...overrides,
    }]);
    return db;
  }

  const reserve = (db: ReturnType<typeof createFakeDb>, orderId: string, email = EMAIL) =>
    db.client.rpc("customer_offer_reserve", {
      p_token_hash: TOKEN_HASH, p_order_id: orderId, p_email: email, p_hold_seconds: 900,
    });

  it("grants the hold to the first order", async () => {
    const db = dbWithOffer();
    const { data } = await reserve(db, "order-1");
    expect((data as unknown[]).length).toBe(1);
    expect(db.table("customer_offers")[0].reserved_order_id).toBe("order-1");
  });

  it("REFUSES a second, concurrent checkout — the whole point of the hold", async () => {
    const db = dbWithOffer();
    await reserve(db, "order-1");
    const { data } = await reserve(db, "order-2");
    expect((data as unknown[]).length, "two orders both hold one prize").toBe(0);
  });

  it("lets the SAME order ask again, which is what a replay looks like", async () => {
    const db = dbWithOffer();
    await reserve(db, "order-1");
    const { data } = await reserve(db, "order-1");
    expect((data as unknown[]).length).toBe(1);
  });

  it("refuses an address the prize was not issued to", async () => {
    const db = dbWithOffer();
    const { data } = await reserve(db, "order-1", "someone.else@example.test");
    expect((data as unknown[]).length, "a forwarded link spent somebody else's prize").toBe(0);
  });

  it("refuses an expired prize, and a revoked one", async () => {
    const expired = dbWithOffer({ expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(((await reserve(expired, "order-1")).data as unknown[]).length).toBe(0);
    const revoked = dbWithOffer({ revoked_at: new Date().toISOString() });
    expect(((await reserve(revoked, "order-1")).data as unknown[]).length).toBe(0);
  });

  it("releases a hold so the next checkout can take it", async () => {
    const db = dbWithOffer();
    await reserve(db, "order-1");
    await db.client.rpc("customer_offer_release", { p_order_id: "order-1" });
    expect(db.table("customer_offers")[0].reserved_order_id).toBeNull();
    const { data } = await reserve(db, "order-2");
    expect((data as unknown[]).length, "a released prize must be spendable again").toBe(1);
  });

  it("REFUSES to release a redeemed prize, which is what makes the release safe everywhere", async () => {
    const db = dbWithOffer();
    await reserve(db, "order-1");
    await db.client.rpc("customer_offer_redeem", { p_order_id: "order-1" });
    await db.client.rpc("customer_offer_release", { p_order_id: "order-1" });
    expect(db.table("customer_offers")[0].redeemed_at, "a spent prize was handed back").toBeTruthy();
    expect(db.table("customer_offers")[0].reserved_order_id).toBe("order-1");
  });

  it("redeems once, so the timestamp stays true on a webhook retry", async () => {
    const db = dbWithOffer();
    await reserve(db, "order-1");
    const first = await db.client.rpc("customer_offer_redeem", { p_order_id: "order-1" });
    const stamp = db.table("customer_offers")[0].redeemed_at;
    const second = await db.client.rpc("customer_offer_redeem", { p_order_id: "order-1" });
    expect(first.data).toBe(true);
    expect(second.data, "a replayed webhook redeemed it twice").toBe(false);
    expect(db.table("customer_offers")[0].redeemed_at).toBe(stamp);
  });

  it("refuses a prize spent by an order that PAID, however old the hold", async () => {
    // The repair case the real SQL spells out: money moved for the first order,
    // so the gift is gone even if its redeem step never ran and the hold aged
    // out. Without this a second checkout by the same address collects it again.
    const db = dbWithOffer({ reserved_order_id: "order-1", reserved_at: new Date(Date.now() - 86_400_000).toISOString() });
    db.seed("orders", [{ id: "o1", order_id: "order-1", payment_status: "paid" }]);
    const { data } = await reserve(db, "order-2");
    expect((data as unknown[]).length, "a paid order's prize was handed to a second order").toBe(0);
  });

  it("DOES hand on a prize whose holding order died before paying", async () => {
    const db = dbWithOffer({ reserved_order_id: "order-1", reserved_at: new Date().toISOString() });
    db.seed("orders", [{ id: "o1", order_id: "order-1", payment_status: "payment_failed" }]);
    const { data } = await reserve(db, "order-2");
    expect((data as unknown[]).length, "a dead checkout squatted on the prize").toBe(1);
  });
});
