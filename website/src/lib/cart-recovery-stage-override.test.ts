import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// REPLACING ONE STAGE, FOR ONE NAMED CART, AND NOTHING ELSE.
//
// Two shoppers were to get a gift in place of their next recovery reminder.
// The override therefore has to be provably narrower than every alternative:
// it must not add a send, must not reach a third cart, must not touch the
// other stages of its own cart, and must not send twice under retry, a
// concurrent sweep, or a redeploy.
//
// The design that makes those provable is that the override changes only WHICH
// TEMPLATE the sweep's single, already-guaranteed send renders. It rides
// inside the existing claim on (abandoned_cart_id, stage) rather than around
// it, so the idempotency below is not new machinery being trusted for the
// first time — it is the sequence's own machinery, re-proved here for the
// replaced stage.
//
// Driven through the REAL runAbandonedCartSweep against the same table-map
// fake the frequency-deferral suite uses.
// ---------------------------------------------------------------------------

vi.unmock("@/lib/cart-recovery");

const HOUR_MS = 3_600_000;
type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  db: { carts: [], stages: [], coupons: [], orders: [], sendLog: [], overrides: [] } as Record<string, Array<Record<string, unknown>>>,
  claim: "claimed" as "claimed" | "deferred" | "duplicate",
  /** Another sweep takes the (cart, stage) slot the instant the guard answers. */
  raceStageOnClaim: null as null | string,
  /** Make the overrides table unreadable, as an un-migrated database would. */
  overridesUnavailable: false,
  /** Make offer minting fail, as a held or unmintable entitlement would. */
  offerMintFails: false,
  suppressed: new Set<string>(),
  sends: [] as Array<{ to: string; campaignType: string; templateKey: unknown; subject: string; html: string; text: string }>,
  issued: [] as Array<{ email: string; offerKey: string; referenceId: unknown }>,
  seq: 0,
  nextLogId: 1,
}));

const { sendMarketingEmail } = vi.hoisted(() => ({
  sendMarketingEmail: vi.fn(async (input: Record<string, unknown>) => {
    state.sends.push({
      to: String(input.to),
      campaignType: String(input.campaignType),
      templateKey: input.templateKey,
      subject: String(input.subject),
      html: String(input.html),
      text: String(input.text),
    });
    return { success: true, providerMessageId: "msg-1" };
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/marketing", () => ({
  sendMarketingEmail,
  isMarketingSuppressed: async (email: string) => state.suppressed.has(email),
}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));
vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async (slugs: string[]) =>
    slugs.map((slug) => ({ slug, name: slug === "bpc-157" ? "BPC-157" : slug })),
}));

// The live promotion resolver, answering as the real configuration does today:
// Buy 2 Get 1 Free is enabled with no end date.
vi.mock("@/lib/bxgy-promotions", () => ({
  getApplicableBxgyPromotions: async () => [{ id: "buy-2-get-1-free", name: "Buy 2 Get 1 Free", hidden: false }],
}));

vi.mock("@/lib/offers/customer-offers", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/offers/customer-offers");
  return {
    ...actual,
    // The OVERRIDE path mints a named catalogue gift by key.
    issueCustomerOffer: async (input: { email: string; offerKey: string; referenceId?: string }) => {
      state.issued.push({ email: input.email, offerKey: input.offerKey, referenceId: input.referenceId });
      if (state.offerMintFails) return null;
      return { token: `tok-${state.issued.length}`, expiresAt: new Date(Date.now() + 8 * 24 * HOUR_MS).toISOString() };
    },
    // THE LADDER path mints a gift assembled from the cart's band, which has no
    // catalogue entry to name — so it goes through issueResolvedOffer instead.
    // Both are recorded here, because the point of this suite is that an
    // override replaces ONE message and leaves the sequence around it minting
    // its own gifts as usual.
    issueResolvedOffer: async (input: { email: string; offerKey: string; referenceId?: string }) => {
      state.issued.push({ email: input.email, offerKey: input.offerKey, referenceId: input.referenceId });
      if (state.offerMintFails) return null;
      return { token: `tok-${state.issued.length}`, expiresAt: new Date(Date.now() + 8 * 24 * HOUR_MS).toISOString() };
    },
  };
});

const config = {
  t30mEnabled: true, t12hEnabled: true, t24hEnabled: true, t72hEnabled: true,
  discountPercent: 5, couponExpirationHours: 48,
};
vi.mock("@/lib/admin-control", () => ({ getCartRecoveryControlConfig: async () => config }));

vi.mock("@/lib/supabase-server", () => {
  function builder(table: string) {
    const TABLES: Record<string, string> = {
      abandoned_carts: "carts", abandoned_cart_emails: "stages", coupons: "coupons",
      orders: "orders", email_send_log: "sendLog", cart_recovery_stage_overrides: "overrides",
    };
    const rows = () => state.db[TABLES[table]] ?? [];
    const filters: Array<(row: Row) => boolean> = [];
    let take: number | null = null;
    const hits = () => {
      if (table === "cart_recovery_stage_overrides" && state.overridesUnavailable) throw new Error("relation does not exist");
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
      range(from: number, to: number) {
        try { return Promise.resolve({ data: hits().slice(from, to + 1), error: null }); }
        catch (error) { return Promise.resolve({ data: null, error }); }
      },
      maybeSingle() { return Promise.resolve({ data: hits()[0] ?? null, error: null }); },
      single() { const r = hits(); return Promise.resolve({ data: r[0] ?? null, error: r[0] ? null : { code: "PGRST116" } }); },
      then(resolve: (v: unknown) => unknown) {
        let settled: unknown;
        try { settled = { data: hits(), error: null }; }
        catch (error) { settled = { data: null, error }; }
        return Promise.resolve(settled).then(resolve);
      },
      insert(payload: Row) {
        if (table === "abandoned_cart_emails") {
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
        const where: Array<[string, unknown, string]> = [];
        const u: Record<string, unknown> = {
          eq(c: string, v: unknown) { where.push([c, v, "eq"]); return u; },
          is(c: string, v: unknown) { where.push([c, v, "is"]); return u; },
          in(c: string, v: unknown[]) { where.push([c, v, "in"]); return u; },
          then(resolve: (v: unknown) => unknown) {
            for (const row of rows()) {
              const hit = where.every(([c, v, op]) => op === "is"
                ? (row[c] ?? null) === v
                : Array.isArray(v) ? v.map(String).includes(String(row[c])) : String(row[c]) === String(v));
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

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    if (state.claim === "deferred") {
      return { data: [{ outcome: "deferred", log_id: null, last_marketing_at: new Date(Date.now() - 3 * HOUR_MS).toISOString() }], error: null };
    }
    if (state.claim === "duplicate") return { data: [{ outcome: "duplicate", log_id: null, last_marketing_at: null }], error: null };
    const id = `log-${state.nextLogId++}`;
    state.db.sendLog.push({
      id, campaign_type: String(args.p_campaign_type), reference_id: String(args.p_reference_id),
      recipient_email: String(args.p_email), status: "sending",
    });
    if (state.raceStageOnClaim) {
      state.db.stages.push({
        id: `stg-race-${++state.seq}`, abandoned_cart_id: String(args.p_reference_id),
        stage: state.raceStageOnClaim, coupon_id: null, sent_at: new Date().toISOString(),
      });
    }
    return { data: [{ outcome: "claimed", log_id: id, last_marketing_at: null }], error: null };
  };

  return { supabaseAdmin: { from: (t: string) => builder(t), rpc } };
});

function seedCart(input: { id?: string; email?: string; hoursAgo: number; value?: number }): Row {
  const cart: Row = {
    id: input.id ?? `cart-${++state.seq}`,
    email: input.email ?? "shopper@example.com",
    customer_name: "Sam",
    items: [{ slug: "bpc-157", name: "BPC-157", quantity: 1, price: 42.99 }],
  // $149.99. The band that a $42.99 cart falls into deliberately carries no
  // percentage, and this suite is about STAGE OVERRIDES rather than about
  // banding — so it sits in a band that exercises both halves of a stage's
  // offer. cart-recovery-tiers.test.ts pins the bands themselves.
    cart_value_cents: input.value ?? 14999,
    first_seen_at: new Date(Date.now() - input.hoursAgo * HOUR_MS).toISOString(),
    last_updated_at: new Date(Date.now() - input.hoursAgo * HOUR_MS).toISOString(),
    status: "active",
  };
  state.db.carts.push(cart);
  return cart;
}

function seedOverride(cartId: string, stage = "t12h", offerKey: string | null = "labor_day_bac_water_2") {
  state.db.overrides.push({ abandoned_cart_id: cartId, stage, offer_key: offerKey, note: "labor day", consumed_at: null, consumed_email_id: null });
}

/** Thirteen hours puts a cart inside the t12h window (12h–24h). */
const IN_T12H = 13;

const { runAbandonedCartSweep } = await import("@/lib/cart-recovery");

beforeEach(() => {
  for (const key of Object.keys(state.db)) state.db[key] = [];
  state.claim = "claimed";
  state.raceStageOnClaim = null;
  state.overridesUnavailable = false;
  state.offerMintFails = false;
  state.suppressed = new Set();
  state.sends = [];
  state.issued = [];
  state.seq = 0;
  state.nextLogId = 1;
  vi.clearAllMocks();
});

describe("the replaced stage", () => {
  it("sends the gift body INSTEAD of the generic reminder, not as well as it", async () => {
    const cart = seedCart({ hoursAgo: IN_T12H });
    seedOverride(String(cart.id));

    const result = await runAbandonedCartSweep();

    expect(result.t12hSent).toBe(1);
    // ONE email, on the t12h stage, carrying the gift template.
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0].campaignType).toBe("cart_recovery_t12h");
    expect(state.sends[0].templateKey).toBe("cartRecoveryGiftTemplate");
    // THE SUBJECT NAMES WHAT THEY LEFT AND WHAT THEY GET. A generic line is
    // the one thing a recovery email cannot afford: it is the only part most
    // recipients ever read.
    expect(state.sends[0].subject).toBe("Your BPC-157 + 2 free Recon Water");
    expect(state.sends[0].subject.length).toBeLessThanOrEqual(60);
    // And nothing from the generic one.
    expect(state.sends[0].subject).not.toBe("Your cart is still saved");
    expect(state.sends[0].html).not.toContain("Still here when you are");
    // Exactly one stage row: the override consumed the t12h slot itself.
    expect(state.db.stages).toEqual([expect.objectContaining({ abandoned_cart_id: cart.id, stage: "t12h" })]);
  });

  it("mints the entitlement and carries it as an httpOnly-bound token, not in the landing URL", async () => {
    const cart = seedCart({ hoursAgo: IN_T12H });
    seedOverride(String(cart.id));

    await runAbandonedCartSweep();

    expect(state.issued).toEqual([
      { email: "shopper@example.com", offerKey: "labor_day_bac_water_2", referenceId: cart.id },
    ]);
    // The token rides in the tracker's `o`, which sets the cookie and drops it.
    // The restore destination itself is the plain cart URL — the token is never
    // a query parameter on a page any script can read.
    expect(state.sends[0].html).toContain("o=tok-1");
    expect(state.sends[0].html).toContain(encodeURIComponent(`https://example.test/cart/restore?id=${cart.id}`));
    expect(state.sends[0].html).not.toContain(`/cart/restore?id=${cart.id}&o=`);
  });

  it("states the gift and the terms the till will actually enforce", async () => {
    const cart = seedCart({ hoursAgo: IN_T12H });
    seedOverride(String(cart.id));

    await runAbandonedCartSweep();

    const { html, text } = state.sends[0];
    expect(html).toContain("2 free Recon Water");
    // describeOfferTerms output — the store's own statement, not copy typed here.
    expect(text).toContain("2 free Recon Water are added to your order");
    expect(text).toContain("$35 or more");
    expect(text).toContain("for this email address only");
  });

  it("mentions a promotion only because the live configuration is running one", async () => {
    const cart = seedCart({ hoursAgo: IN_T12H });
    seedOverride(String(cart.id));

    await runAbandonedCartSweep();

    expect(state.sends[0].text).toContain("Buy 2 Get 1 Free");
  });

  it("makes NO deadline, scarcity, shipping-speed or purity claim", async () => {
    // The copy rules for this brand, asserted rather than trusted. The gift's
    // own expiry is stated by describeOfferTerms and is a real, enforced date;
    // everything below would be invented.
    const cart = seedCart({ hoursAgo: IN_T12H });
    seedOverride(String(cart.id));

    await runAbandonedCartSweep();

    const copy = `${state.sends[0].subject} ${state.sends[0].text}`.toLowerCase();
    for (const forbidden of [
      "limited time", "limited-time", "ends ", "ending", "last chance", "hurry", "act now",
      "only a few", "while supplies last", "selling out", "labor day",
      "2-day", "two-day", "next day", "overnight",
      "purity", "99%", "guaranteed",
    ]) {
      expect(copy, `copy must not claim "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

describe("it cannot send twice", () => {
  it("RETRY: a second sweep finds the stage claimed and sends nothing", async () => {
    const cart = seedCart({ hoursAgo: IN_T12H });
    seedOverride(String(cart.id));

    expect((await runAbandonedCartSweep()).t12hSent).toBe(1);
    expect((await runAbandonedCartSweep()).t12hSent).toBe(0);
    expect((await runAbandonedCartSweep()).t12hSent).toBe(0);

    expect(state.sends).toHaveLength(1);
    expect(state.issued).toHaveLength(1);
    expect(state.db.stages).toHaveLength(1);
  });

  it("REDEPLOY: the guard is the database row, so a fresh process still sends nothing", async () => {
    // A redeploy loses every in-memory flag and re-imports the module. What it
    // cannot lose is the abandoned_cart_emails row, which is the whole reason
    // the claim lives there rather than in a cache.
    const cart = seedCart({ hoursAgo: IN_T12H });
    seedOverride(String(cart.id));
    await runAbandonedCartSweep();
    expect(state.sends).toHaveLength(1);

    vi.resetModules();
    const { runAbandonedCartSweep: afterRedeploy } = await import("@/lib/cart-recovery");
    const result = await afterRedeploy();

    expect(result.t12hSent).toBe(0);
    expect(state.sends).toHaveLength(1);
  });

  it("CONCURRENT SWEEP: the loser hits 23505, sends nothing and mints nothing", async () => {
    const cart = seedCart({ hoursAgo: IN_T12H });
    seedOverride(String(cart.id));
    // Another sweep claims the slot in the instant between the guard and the
    // insert — the only interleaving where the insert itself can collide.
    state.raceStageOnClaim = "t12h";

    const result = await runAbandonedCartSweep();

    expect(result.t12hSent).toBe(0);
    expect(state.sends).toHaveLength(0);
    // MINTING HAPPENS BEHIND THE CLAIM, so the loser never issued a gift.
    expect(state.issued).toHaveLength(0);
    expect(state.db.stages).toHaveLength(1);
    expect(String(state.db.stages[0].id)).toMatch(/^stg-race-/);
  });

  it("marks the override consumed once, and only after the send succeeded", async () => {
    const cart = seedCart({ hoursAgo: IN_T12H });
    seedOverride(String(cart.id));

    await runAbandonedCartSweep();

    const row = state.db.overrides[0];
    expect(row.consumed_at).toBeTruthy();
    expect(row.consumed_email_id).toBe(state.db.stages[0].id);
  });

  it("a consumed override still renders the gift body, never silently the generic one", async () => {
    // Defensive, and the reason the template lookup ignores consumed_at: if a
    // send were somehow re-attempted, the shopper must get the message they
    // were promised rather than a reminder that contradicts it.
    const cart = seedCart({ hoursAgo: IN_T12H });
    seedOverride(String(cart.id));
    await runAbandonedCartSweep();

    // Free the stage slot the way only a hand-repair could, and sweep again.
    state.db.stages.length = 0;
    await runAbandonedCartSweep();

    expect(state.sends).toHaveLength(2);
    expect(state.sends[1].templateKey).toBe("cartRecoveryGiftTemplate");
  });
});

describe("nothing is sent when the gift cannot be honoured", () => {
  it("an unmintable entitlement sends NOTHING and leaves the stage retryable", async () => {
    const cart = seedCart({ hoursAgo: IN_T12H });
    seedOverride(String(cart.id));
    state.offerMintFails = true;

    const result = await runAbandonedCartSweep();

    expect(result.t12hSent).toBe(0);
    expect(state.sends).toHaveLength(0);
    // The reservation was released, so a later sweep can try again inside the
    // window rather than the shopper losing the stage entirely.
    expect(state.db.stages).toHaveLength(0);

    state.offerMintFails = false;
    expect((await runAbandonedCartSweep()).t12hSent).toBe(1);
    expect(state.sends).toHaveLength(1);
  });

  it("an override naming an offer key the catalogue no longer has falls back to the ordinary stage", async () => {
    const cart = seedCart({ hoursAgo: IN_T12H });
    seedOverride(String(cart.id), "t12h", "an_offer_that_was_retired");

    const result = await runAbandonedCartSweep();

    // The shopper gets their normal reminder rather than bespoke copy
    // promising a gift that cannot exist.
    expect(result.t12hSent).toBe(1);
    expect(state.sends[0].templateKey).toBe("cartRecoveryT12hTemplate");
    expect(state.issued).toHaveLength(0);
  });

  it("an unreadable overrides table sends the ordinary sequence rather than nothing", async () => {
    const cart = seedCart({ hoursAgo: IN_T12H });
    seedOverride(String(cart.id));
    state.overridesUnavailable = true;

    const result = await runAbandonedCartSweep();

    expect(result.t12hSent).toBe(1);
    expect(state.sends[0].templateKey).toBe("cartRecoveryT12hTemplate");
  });
});

describe("the blast radius", () => {
  it("reaches ONLY the carts named in the table", async () => {
    const chosen = seedCart({ id: "cart-chosen", email: "chosen@example.com", hoursAgo: IN_T12H });
    // Every shape of cart that must NOT qualify: a bigger one, a smaller one,
    // and one belonging to somebody else at the same moment in its sequence.
    seedCart({ id: "cart-big", email: "big@example.com", hoursAgo: IN_T12H, value: 519_90 });
    seedCart({ id: "cart-small", email: "small@example.com", hoursAgo: IN_T12H, value: 999 });
    seedCart({ id: "cart-other", email: "other@example.com", hoursAgo: IN_T12H });
    seedOverride(String(chosen.id));

    const result = await runAbandonedCartSweep();

    expect(result.t12hSent).toBe(4);
    const gift = state.sends.filter((send) => send.templateKey === "cartRecoveryGiftTemplate");
    expect(gift).toHaveLength(1);
    expect(gift[0].to).toBe("chosen@example.com");
    // Everyone else got exactly the mail they would have got anyway.
    expect(state.sends.filter((s) => s.templateKey === "cartRecoveryT12hTemplate").map((s) => s.to).sort())
      .toEqual(["big@example.com", "other@example.com", "small@example.com"]);
    expect(state.issued).toHaveLength(1);
  });

  it("replaces ONLY the stage it names, leaving the rest of that cart's sequence alone", async () => {
    // t30m first, then the replaced t12h, then t24h — one cart, walked through
    // its own sequence, with only the middle message swapped.
    const cart = seedCart({ hoursAgo: 2 });
    seedOverride(String(cart.id));

    expect((await runAbandonedCartSweep()).t30mSent).toBe(1);
    expect(state.sends[0].templateKey).toBe("cartRecoveryT30mTemplate");

    // Time passes for the stage rows too: the sweep holds any stage inside
    // MIN_STAGE_GAP_MS of the previous send, so the earlier stage must be as
    // old as the cart's own clock says it is.
    const ageStages = () => { for (const row of state.db.stages) row.sent_at = new Date(Date.now() - 48 * HOUR_MS).toISOString(); };
    (cart as Row).last_updated_at = new Date(Date.now() - IN_T12H * HOUR_MS).toISOString();
    (cart as Row).first_seen_at = new Date(Date.now() - IN_T12H * HOUR_MS).toISOString();
    ageStages();
    expect((await runAbandonedCartSweep()).t12hSent).toBe(1);
    expect(state.sends[1].templateKey).toBe("cartRecoveryGiftTemplate");

    (cart as Row).last_updated_at = new Date(Date.now() - 25 * HOUR_MS).toISOString();
    (cart as Row).first_seen_at = new Date(Date.now() - 25 * HOUR_MS).toISOString();
    ageStages();
    expect((await runAbandonedCartSweep()).t24hSent).toBe(1);
    expect(state.sends[2].templateKey).toBe("cartRecoveryT24hTemplate");

    // TWO entitlements, and which is which is the point. The override minted
    // its own named gift at the stage it replaced; stage 3 then minted the
    // standing ladder gift it now carries for every qualifying cart. The
    // override replaced one message, not the sequence around it.
    expect(state.issued.map((issue) => issue.offerKey)).toEqual([
      "labor_day_bac_water_2",
      "cart_recovery_bac_water",
    ]);
    expect(state.db.stages.map((s) => s.stage)).toEqual(["t30m", "t12h", "t24h"]);
  });

  it("sends nothing at all once the cart has converted", async () => {
    const cart = seedCart({ hoursAgo: IN_T12H });
    seedOverride(String(cart.id));
    // The payment webhook's mark. The sweep reads only 'active' rows.
    (cart as Row).status = "recovered";

    const result = await runAbandonedCartSweep();

    expect(result.t12hSent).toBe(0);
    expect(state.sends).toHaveLength(0);
    expect(state.issued).toHaveLength(0);
    // And the entitlement was never minted, so nothing is outstanding.
    expect(state.db.overrides[0].consumed_at).toBeNull();
  });

  it("sends nothing to a shopper who has unsubscribed, and mints them nothing", async () => {
    const cart = seedCart({ hoursAgo: IN_T12H });
    seedOverride(String(cart.id));
    state.suppressed.add("shopper@example.com");

    const result = await runAbandonedCartSweep();

    expect(result.t12hSent).toBe(0);
    expect(state.sends).toHaveLength(0);
    expect(state.issued).toHaveLength(0);
    expect(state.db.stages).toHaveLength(0);
  });

  it("defers to the frequency guard exactly as an ordinary stage does", async () => {
    const cart = seedCart({ hoursAgo: IN_T12H });
    seedOverride(String(cart.id));
    state.claim = "deferred";

    expect((await runAbandonedCartSweep()).t12hSent).toBe(0);
    expect(state.issued).toHaveLength(0);
    expect(state.db.stages).toHaveLength(0);

    state.claim = "claimed";
    expect((await runAbandonedCartSweep()).t12hSent).toBe(1);
  });
});

describe("a replaced stage whose gift also carries a percentage", () => {
  // The 72-hour follow-up. It is a different message from the first one in
  // three specific ways, and each is a consequence of the store granting ONE
  // discount per order rather than a styling choice.
  beforeEach(() => {
    state.db.overrides.length = 0;
  });

  function seedPercentOverride(cartId: string) {
    state.db.overrides.push({
      abandoned_cart_id: cartId, stage: "t72h", offer_key: "labor_day_bac_water_2_40",
      perks: ["Free shipping"], note: "72h follow-up", consumed_at: null, consumed_email_id: null,
    });
  }

  it("leads with the percentage, because it is the bigger number", async () => {
    const cart = seedCart({ hoursAgo: 73 });
    // Earlier stages went a day or more ago, as they do for a 73-hour-old cart:
    // the sweep holds any stage inside MIN_STAGE_GAP_MS of the previous send.
    for (const stage of ["t30m", "t12h", "t24h"]) {
      state.db.stages.push({ id: `pre-${stage}`, abandoned_cart_id: cart.id, stage, sent_at: new Date(Date.now() - 48 * HOUR_MS).toISOString() });
    }
    seedPercentOverride(String(cart.id));

    const result = await runAbandonedCartSweep();

    expect(result.t72hSent).toBe(1);
    const sent = state.sends[0];
    expect(sent.subject).toBe("40% off your BPC-157");
    expect(sent.html).toContain("40% off, plus 2 free Recon Water");
    expect(sent.html).toContain("Claim my 40% off");
  });

  it("does NOT name the promotion beside it, because the percentage replaces it", async () => {
    // Buy 2 Get 1 is live for this customer and worth less than 40%. Naming
    // both would promise a stack the checkout refuses — the shopper gets the
    // better of the two, and here that is the 40%.
    const cart = seedCart({ hoursAgo: 73 });
    for (const stage of ["t30m", "t12h", "t24h"]) {
      state.db.stages.push({ id: `pre2-${stage}`, abandoned_cart_id: cart.id, stage, sent_at: new Date(Date.now() - 48 * HOUR_MS).toISOString() });
    }
    seedPercentOverride(String(cart.id));

    await runAbandonedCartSweep();

    const body = `${state.sends[0].subject} ${state.sends[0].text}`;
    expect(body).not.toContain("Buy 2 Get 1");
    // And the terms still state both halves the till will honour.
    expect(state.sends[0].text).toContain("40% off");
    expect(state.sends[0].text).toContain("2 free Recon Water are added to your order");
  });

  // FOUR REAL OVERRIDE ROWS WERE WAITING TO SEND WITH THIS EXACT SHAPE.
  //
  // The operator typed "Free shipping" into the perks of every unconsumed
  // override, and the sweep adds its own when the sitewide switch is on. The
  // highest-value cart in the store was two hours from being mailed a list
  // reading "Free shipping / Free shipping / 2-day shipping, on us". Caught by
  // reading the pending rows during a scheduled check, not by any test — so
  // this is the test.
  it("says a perk once, however many places it came from", async () => {
    const cart = seedCart({ hoursAgo: 73 });
    for (const stage of ["t30m", "t12h", "t24h"]) {
      state.db.stages.push({ id: `dedupe-${stage}`, abandoned_cart_id: cart.id, stage, sent_at: new Date(Date.now() - 48 * HOUR_MS).toISOString() });
    }
    state.db.overrides.push({
      abandoned_cart_id: String(cart.id), stage: "t72h", offer_key: "labor_day_bac_water_2_40",
      // As stored on the live rows: the operator's own wording, plus a second
      // perk, plus a casing/spacing variant that must also collapse.
      perks: ["Free shipping", "2-day shipping, on us", "  free SHIPPING "],
      note: "72h follow-up", consumed_at: null, consumed_email_id: null,
    });

    await runAbandonedCartSweep();

    const html = state.sends[0].html;
    // The bullets themselves, not the whole message: the body states the
    // store's shipping terms elsewhere too, and that sentence is not a perk.
    const bullets = (html.match(/&#8226;<\/span>&nbsp;&nbsp;([^<]+)/g) ?? [])
      .map((bullet) => bullet.replace(/.*&nbsp;/, "").trim());
    expect(bullets).toEqual(["Free shipping", "2-day shipping, on us"]);
  });

  it("still mints exactly one entitlement, and only for that cart", async () => {
    const chosen = seedCart({ id: "cart-follow", email: "chosen@example.com", hoursAgo: 73 });
    const bystander = seedCart({ id: "cart-bystander", email: "other@example.com", hoursAgo: 73 });
    for (const cart of [chosen, bystander]) {
      for (const stage of ["t30m", "t12h", "t24h"]) {
        state.db.stages.push({ id: `p-${cart.id}-${stage}`, abandoned_cart_id: cart.id, stage, sent_at: new Date(Date.now() - 48 * HOUR_MS).toISOString() });
      }
    }
    seedPercentOverride(String(chosen.id));

    await runAbandonedCartSweep();

    // THE OVERRIDE'S GIFT REACHES EXACTLY ONE ADDRESS. That is what this test
    // is about, and it is unchanged: nobody but the named cart is issued
    // `labor_day_bac_water_2_40`.
    expect(state.issued.filter((issue) => issue.offerKey === "labor_day_bac_water_2_40")).toEqual([
      { email: "chosen@example.com", offerKey: "labor_day_bac_water_2_40", referenceId: "cart-follow" },
    ]);
    // The bystander got the ordinary last-chance mail — which now carries the
    // standing ladder gift alongside its coupon. A different offer key, minted
    // by the ordinary path, for its own cart.
    const bystanderSend = state.sends.find((s) => s.to === "other@example.com");
    expect(bystanderSend?.templateKey).toBe("cartRecoveryT72hTemplate");
    expect(state.issued).toContainEqual(
      { email: "other@example.com", offerKey: "cart_recovery_bac_water", referenceId: "cart-bystander" },
    );
  });
});
