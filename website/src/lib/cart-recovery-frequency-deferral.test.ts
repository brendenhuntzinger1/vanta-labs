import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// CART RECOVERY ASKS THE FREQUENCY GUARD BEFORE IT RESERVES OR MINTS ANYTHING.
//
// reserveAndSendStage now calls marketing_send_claim FIRST — before the
// (cart, stage) reservation in abandoned_cart_emails and before any coupon is
// minted. The order is what keeps "at most one coupon per cart per stage" true:
// a deferral after the mint would have to either burn the stage or re-mint.
//
// Pinned here, through the REAL runAbandonedCartSweep against the table-map
// fake the sequence test uses, plus an rpc driven by test state:
//
//   deferred   no reservation row, no coupon, no send, and the sweep reports
//              the stage as not sent — the next sweep tries again while the
//              stage's window is open;
//   claimed    the stage is sent exactly once, and the guard's log id rides
//              into sendMarketingEmail as claimedLogId so the wrapper closes
//              THAT row rather than claiming twice;
//   claimed but the stage is already taken (23505)
//              the claim row is released 'failed' so it neither blocks the
//              inbox nor reads as a send, and nothing goes out;
//   the arguments
//              the guard is told the cart-recovery family (so a cart's own
//              earlier reminders do not defer its later ones) and the cart id
//              as the reference.
// ---------------------------------------------------------------------------

vi.unmock("@/lib/cart-recovery");

const HOUR_MS = 3_600_000;
type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  db: { carts: [], stages: [], coupons: [], orders: [], sendLog: [] } as Record<string, Array<Record<string, unknown>>>,
  /** What marketing_send_claim answers. */
  claim: "claimed" as "claimed" | "deferred" | "duplicate",
  /**
   * When true, another sweep takes the (cart, stage) slot the instant the guard
   * answers 'claimed' — the interleaving the 23505 branch exists for. A row
   * seeded BEFORE the sweep would be seen by the bulk claimed-stages read and
   * the cart would never become a candidate; the race is the only way the
   * insert itself can collide.
   */
  raceStageOnClaim: false,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /** Every update made to email_send_log, with its filters. */
  logUpdates: [] as Array<{ patch: Record<string, unknown>; where: Array<[string, unknown]> }>,
  sends: [] as Array<{ to: string; campaignType: string; referenceId: unknown; claimedLogId: unknown }>,
  seq: 0,
  nextLogId: 1,
}));

const { sendMarketingEmail } = vi.hoisted(() => ({
  sendMarketingEmail: vi.fn(async (input: Record<string, unknown>) => {
    state.sends.push({
      to: String(input.to),
      campaignType: String(input.campaignType),
      referenceId: input.referenceId,
      claimedLogId: input.claimedLogId,
    });
    return { success: true, providerMessageId: "msg-1" };
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/marketing", () => ({ sendMarketingEmail, isMarketingSuppressed: async () => false }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));
// Product names come from the catalogue at send time, never from the stored
// snapshot (AUTH-3): the mock answers every slug the fixtures use.
vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async (slugs: string[]) => slugs.map((slug) => ({ slug, name: slug === "bpc-157" ? "BPC-157" : slug })),
}));

const config = {
  t30mEnabled: true, t12hEnabled: false, t24hEnabled: true, t72hEnabled: true,
  discountPercent: 5, couponExpirationHours: 48,
};
vi.mock("@/lib/admin-control", () => ({ getCartRecoveryControlConfig: async () => config }));

// PostgREST-shaped, honouring the filters the sweep actually uses.
vi.mock("@/lib/supabase-server", () => {
  function builder(table: string) {
    const TABLES: Record<string, string> = {
      abandoned_carts: "carts", abandoned_cart_emails: "stages", coupons: "coupons", orders: "orders", email_send_log: "sendLog",
    };
    const rows = () => state.db[TABLES[table]] ?? [];
    const filters: Array<(row: Row) => boolean> = [];
    let take: number | null = null;
    const hits = () => {
      const out = rows().filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }));
      return take === null ? out : out.slice(0, take);
    };
    const b: Record<string, unknown> = {
      select() { return b; },
      eq(c: string, v: unknown) { filters.push((r) => String(r[c]) === String(v)); return b; },
      gte(c: string, v: unknown) { filters.push((r) => String(r[c] ?? "") >= String(v)); return b; },
      or(clauses: string) {
        filters.push((r) => clauses.split(",").some((clause) => {
          const [c, o, ...rest] = clause.split(".");
          const v = rest.join(".");
          if (o === "gte") return String(r[c] ?? "") >= v;
          if (o === "lte") return String(r[c] ?? "") <= v;
          if (o === "is" && v === "null") return r[c] === null || r[c] === undefined;
          if (o === "eq") return String(r[c]) === v;
          return false;
        }));
        return b;
      },
      gt(c: string, v: unknown) { filters.push((r) => String(r[c] ?? "") > String(v)); return b; },
      in(c: string, v: unknown[]) { filters.push((r) => v.map(String).includes(String(r[c]))); return b; },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b; },
      order() { return b; },
      limit(n: number) { take = n; return b; },
      range(from: number, to: number) { return Promise.resolve({ data: hits().slice(from, to + 1), error: null }); },
      maybeSingle() { return Promise.resolve({ data: hits()[0] ?? null, error: null }); },
      single() { const r = hits(); return Promise.resolve({ data: r[0] ?? null, error: r[0] ? null : { code: "PGRST116" } }); },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve({ data: hits(), error: null }).then(resolve); },
      insert(payload: Row) {
        if (table === "abandoned_cart_emails") {
          // The unique index idx_abandoned_cart_emails_cart_stage.
          const clash = rows().some((r) => r.abandoned_cart_id === payload.abandoned_cart_id && r.stage === payload.stage);
          const settled = clash
            ? { data: null, error: { code: "23505", message: "duplicate key" } }
            : (() => { const row = { id: `stg-${++state.seq}`, ...payload }; rows().push(row); return { data: { id: row.id }, error: null }; })();
          return { select: () => ({ single: async () => settled, maybeSingle: async () => settled }) };
        }
        const row = { id: `${table}-${++state.seq}`, ...payload };
        rows().push(row);
        const settled = { data: { id: row.id }, error: null };
        return {
          select: () => ({ single: async () => settled, maybeSingle: async () => settled }),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
        };
      },
      update(payload: Row) {
        const where: Array<[string, unknown]> = [];
        const u: Record<string, unknown> = {
          eq(c: string, v: unknown) { where.push([c, v]); return u; },
          in(c: string, v: unknown[]) { where.push([c, v]); return u; },
          then(resolve: (v: unknown) => unknown) {
            if (table === "email_send_log") state.logUpdates.push({ patch: payload, where });
            for (const row of rows()) {
              const hit = where.every(([c, v]) => Array.isArray(v) ? v.map(String).includes(String(row[c])) : String(row[c]) === String(v));
              if (hit) Object.assign(row, payload);
            }
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        };
        return u;
      },
      delete() {
        return { eq(c: string, v: unknown) { const keep = rows().filter((r) => r[c] !== v); rows().length = 0; rows().push(...keep); return Promise.resolve({ error: null }); } };
      },
    };
    return b;
  }

  // marketing_send_claim, as the database function behaves: a claim WRITES the
  // send-log row itself at 'sending' and hands back its id.
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    state.rpcCalls.push({ fn, args });
    if (state.claim === "deferred") {
      return {
        data: [{ outcome: "deferred", log_id: null, last_marketing_at: new Date(Date.now() - 3 * HOUR_MS).toISOString() }],
        error: null,
      };
    }
    if (state.claim === "duplicate") {
      return { data: [{ outcome: "duplicate", log_id: null, last_marketing_at: null }], error: null };
    }
    const id = `log-${state.nextLogId++}`;
    state.db.sendLog.push({
      id,
      campaign_type: String(args.p_campaign_type),
      reference_id: String(args.p_reference_id),
      recipient_email: String(args.p_email),
      status: "sending",
    });
    if (state.raceStageOnClaim) {
      state.db.stages.push({
        id: `stg-race-${++state.seq}`,
        abandoned_cart_id: String(args.p_reference_id),
        stage: "t30m",
        coupon_id: null,
        sent_at: new Date().toISOString(),
      });
    }
    return { data: [{ outcome: "claimed", log_id: id, last_marketing_at: null }], error: null };
  };

  return { supabaseAdmin: { from: (t: string) => builder(t), rpc } };
});

function seedCart(input: { id?: string; email?: string; firstSeenHoursAgo: number; lastUpdatedHoursAgo?: number; value?: number }): Row {
  const cart: Row = {
    id: input.id ?? `cart-${++state.seq}`,
    email: input.email ?? "shopper@example.com",
    customer_name: "Sam",
    items: [{ slug: "bpc-157", name: "BPC-157", quantity: 1, price: 42.99 }],
    cart_value_cents: input.value ?? 4299,
    first_seen_at: new Date(Date.now() - input.firstSeenHoursAgo * HOUR_MS).toISOString(),
    last_updated_at: new Date(Date.now() - (input.lastUpdatedHoursAgo ?? input.firstSeenHoursAgo) * HOUR_MS).toISOString(),
    status: "active",
  };
  state.db.carts.push(cart);
  return cart;
}

const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");

beforeEach(() => {
  state.db.carts = []; state.db.stages = []; state.db.coupons = []; state.db.orders = []; state.db.sendLog = [];
  state.claim = "claimed";
  state.raceStageOnClaim = false;
  state.rpcCalls = [];
  state.logUpdates = [];
  state.sends = [];
  state.seq = 0;
  state.nextLogId = 1;
  vi.clearAllMocks();
});

describe("a due t30m stage and the frequency guard", () => {
  it("DEFERRED: reserves nothing, mints nothing, sends nothing, and reports the stage as not sent", async () => {
    // Two hours since the last cart change: inside the t30m window (1h–12h).
    seedCart({ firstSeenHoursAgo: 2 });
    state.claim = "deferred";

    const result = await runAbandonedCartSweep();

    expect(result.eligible).toBe(1);
    expect(result.t30mSent).toBe(0);
    expect(result.t12hSent + result.t24hSent + result.t72hSent).toBe(0);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.db.stages).toHaveLength(0);
    expect(state.db.coupons).toHaveLength(0);
    expect(sendMarketingEmail).not.toHaveBeenCalled();
    // The guard wrote nothing, and nothing was closed.
    expect(state.db.sendLog).toHaveLength(0);
    expect(state.logUpdates).toHaveLength(0);
  });

  it("DEFERRED on the stage that mints (t72h): the coupon is never minted", async () => {
    // The order of guard → reservation → mint is the whole point; t30m
    // carries no coupon, so the last stage is where a mint would show.
    seedCart({ firstSeenHoursAgo: 73 });
    state.claim = "deferred";

    const result = await runAbandonedCartSweep();

    expect(result.eligible).toBe(1);
    expect(result.t72hSent).toBe(0);
    expect(state.db.coupons).toHaveLength(0);
    expect(state.db.stages).toHaveLength(0);
    expect(sendMarketingEmail).not.toHaveBeenCalled();

    // Control: once the guard relents, the same stage mints exactly one code.
    state.claim = "claimed";
    const later = await runAbandonedCartSweep();
    expect(later.t72hSent).toBe(1);
    expect(state.db.coupons).toHaveLength(1);
  });

  it("CLAIMED on a later sweep: sends the stage exactly once, with the guard's log id as claimedLogId", async () => {
    const cart = seedCart({ firstSeenHoursAgo: 2 });

    state.claim = "deferred";
    const first = await runAbandonedCartSweep();
    expect(first.t30mSent).toBe(0);
    expect(state.sends).toHaveLength(0);

    state.claim = "claimed";
    const second = await runAbandonedCartSweep();
    expect(second.t30mSent).toBe(1);
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0]).toMatchObject({ to: "shopper@example.com", campaignType: "cart_recovery_t30m", referenceId: cart.id });

    // The claim row the guard wrote is the one handed to the wrapper to close.
    expect(state.db.sendLog).toHaveLength(1);
    expect(state.sends[0].claimedLogId).toBe(state.db.sendLog[0].id);
    expect(state.db.stages).toEqual([expect.objectContaining({ abandoned_cart_id: cart.id, stage: "t30m" })]);

    // A third sweep finds the stage claimed: no new claim, no second send.
    const third = await runAbandonedCartSweep();
    expect(third.t30mSent).toBe(0);
    expect(state.sends).toHaveLength(1);
    expect(state.rpcCalls).toHaveLength(2);
  });

  it("CLAIMED but the stage insert hits 23505: the claim row is closed 'failed' and nothing is sent", async () => {
    const cart = seedCart({ firstSeenHoursAgo: 2 });
    state.claim = "claimed";
    state.raceStageOnClaim = true;

    const result = await runAbandonedCartSweep();

    expect(result.t30mSent).toBe(0);
    expect(sendMarketingEmail).not.toHaveBeenCalled();
    expect(state.db.coupons).toHaveLength(0);
    // The only stage row is the racing sweep's; this sweep added none.
    expect(state.db.stages).toEqual([expect.objectContaining({ abandoned_cart_id: cart.id, stage: "t30m", id: expect.stringMatching(/^stg-race-/) })]);

    // The claim was released: an update on email_send_log setting status
    // 'failed' for exactly the id the guard handed back.
    const logId = state.db.sendLog[0].id;
    expect(state.logUpdates).toEqual([{ patch: { status: "failed" }, where: [["id", logId]] }]);
    expect(state.db.sendLog).toEqual([expect.objectContaining({ id: logId, status: "failed" })]);
  });

  it("names the cart-recovery family and the cart id when it asks the guard", async () => {
    const cart = seedCart({ firstSeenHoursAgo: 2 });

    await runAbandonedCartSweep();

    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].fn).toBe("marketing_send_claim");
    expect(state.rpcCalls[0].args).toEqual({
      p_email: "shopper@example.com",
      p_campaign_type: "cart_recovery_t30m",
      p_reference_id: cart.id,
      p_template_key: "cartRecoveryT30mTemplate",
      p_quiet_seconds: 86_400,
      p_exempt_family: "cart_recovery_",
    });
  });
});
