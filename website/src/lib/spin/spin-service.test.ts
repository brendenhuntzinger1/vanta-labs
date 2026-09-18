import { beforeEach, describe, expect, it, vi } from "vitest";

import { SPIN_PRIZES } from "@/lib/spin/prize-table";

// ---------------------------------------------------------------------------
// ONE SPIN, AND WHAT IT TAKES TO MEAN IT.
//
// The obvious implementation calls issueResolvedOffer and lets the partial
// unique index enforce "one live offer per (offer_key, email)". That is wrong
// here, and quietly so: issueResolvedOffer RETIRES the blocking row and mints a
// fresh one. It is right to — a win-back whose token was lost in a failed send
// must be re-sendable — but on a wheel it is a re-roll. POST twice and the
// second draw replaces the first, so anyone who can press a button twice spins
// until they like the prize.
//
// So this service never reissues. It reads first, and treats a unique violation
// as "you already span" rather than as something to clear out of the way.
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  offer_key: string;
  email: string;
  token_hash: string;
  reward_kind: string;
  product_slug: string | null;
  percent_off: number | null;
  quantity: number | null;
  min_subtotal_cents: number;
  expires_at: string;
  reserved_order_id: string | null;
  revoked_at: string | null;
  redeemed_at: string | null;
};

const db = vi.hoisted(() => ({ rows: [] as Row[], inserts: 0 }));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase-server", () => {
  const live = (row: Row) => row.revoked_at === null && row.redeemed_at === null;
  const from = (table: string) => {
    if (table !== "customer_offers") throw new Error(`unexpected table ${table}`);
    const filters: Array<(row: Row) => boolean> = [];
    let limitTo: number | null = null;
    const chain: Record<string, unknown> = {
      insert(values: Record<string, unknown>) {
        db.inserts += 1;
        const offerKey = values.offer_key as string;
        const email = values.email as string;
        // The partial unique index, as Postgres applies it.
        if (db.rows.some((r) => r.offer_key === offerKey && r.email === email && live(r))) {
          const conflict = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          return { select: () => ({ maybeSingle: async () => conflict }), then: (r: (v: unknown) => void) => r(conflict) };
        }
        const row: Row = {
          id: `row-${db.rows.length + 1}`,
          offer_key: offerKey,
          email,
          token_hash: values.token_hash as string,
          reward_kind: values.reward_kind as string,
          product_slug: (values.product_slug as string) ?? null,
          percent_off: (values.percent_off as number) ?? null,
          quantity: (values.quantity as number) ?? null,
          min_subtotal_cents: values.min_subtotal_cents as number,
          expires_at: values.expires_at as string,
          reserved_order_id: null,
          revoked_at: null,
          redeemed_at: null,
        };
        db.rows.push(row);
        const ok = { data: { id: row.id }, error: null };
        return { select: () => ({ maybeSingle: async () => ok }), then: (r: (v: unknown) => void) => r(ok) };
      },
      select: () => chain,
      eq(column: keyof Row, value: unknown) { filters.push((r) => r[column] === value); return chain; },
      is(column: keyof Row, value: null) { filters.push((r) => r[column] === value); return chain; },
      /**
       * PostgREST's `or`, to the extent this service uses it: a comma-separated
       * list of `column.op.value`, ORed together and ANDed with everything else.
       * Only `is.null` and `eq.<value>` appear here; anything else throws rather
       * than silently matching, so a future filter cannot pass by being ignored.
       */
      or(expression: string) {
        const clauses = expression.split(",").map((clause) => {
          const [column, op, ...rest] = clause.split(".");
          const value = rest.join(".");
          if (op === "is" && value === "null") return (r: Row) => r[column as keyof Row] === null;
          if (op === "eq") return (r: Row) => String(r[column as keyof Row] ?? "") === value;
          throw new Error(`mock does not implement or(${clause})`);
        });
        filters.push((r) => clauses.some((match) => match(r)));
        return chain;
      },
      order() { return chain; },
      limit(count: number) { limitTo = count; return chain; },
      async maybeSingle() {
        const hit = db.rows.filter((r) => filters.every((f) => f(r)));
        return { data: hit[0] ?? null, error: null };
      },
      // A bare await on the builder resolves to the matching ROWS, which is how
      // a `.limit(n)` read without `.maybeSingle()` behaves.
      then(resolve: (value: unknown) => void) {
        const hit = db.rows.filter((r) => filters.every((f) => f(r)));
        resolve({ data: limitTo === null ? hit : hit.slice(0, limitTo), error: null });
      },
    };
    return chain;
  };
  return { supabaseAdmin: { from } };
});

const { spin, readExistingSpin, spinOfferKey } = await import("@/lib/spin/spin-service");

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const CAMPAIGN = "winback_2026q4";
const EMAIL = "lapsed@example.test";

/** A draw pinned to one wedge, so a test asserts about a known prize. */
const always = (id: string) => () => SPIN_PRIZES.findIndex((prize) => prize.id === id);

beforeEach(() => {
  db.rows = [];
  db.inserts = 0;
});

describe("the first spin", () => {
  it("mints an offer and hands back the token exactly once", async () => {
    const result = await spin({ email: EMAIL, campaignId: CAMPAIGN, now: NOW, randomInt: always("klow") });

    expect(result?.prize.id).toBe("klow");
    expect(result?.alreadySpun).toBe(false);
    expect(result?.offerToken, "the minting call is the only one that ever sees the token").toBeTruthy();
    expect(db.rows).toHaveLength(1);
  });

  it("writes the prize the wheel will show, not a name it has to resolve later", async () => {
    await spin({ email: EMAIL, campaignId: CAMPAIGN, now: NOW, randomInt: always("ghk_cu") });

    expect(db.rows[0]).toMatchObject({
      offer_key: spinOfferKey(CAMPAIGN),
      email: EMAIL,
      reward_kind: "free_product",
      product_slug: "ghk-cu",
      min_subtotal_cents: 7_500,
    });
  });

  it("stores only the hash of the token", async () => {
    const result = await spin({ email: EMAIL, campaignId: CAMPAIGN, now: NOW, randomInt: always("semax") });
    expect(db.rows[0].token_hash).not.toBe(result?.offerToken);
    expect(db.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the prize 72 hours and not the 30 days a win-back gift gets", async () => {
    const result = await spin({ email: EMAIL, campaignId: CAMPAIGN, now: NOW, randomInt: always("glp_1") });
    expect(new Date(result!.expiresAt).getTime() - NOW).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it("lowercases the address, so the same person is one spinner", async () => {
    await spin({ email: "Lapsed@Example.TEST", campaignId: CAMPAIGN, now: NOW, randomInt: always("mt_2") });
    expect(db.rows[0].email).toBe(EMAIL);
  });
});

describe("the second spin", () => {
  it("returns the first prize rather than drawing again", async () => {
    const first = await spin({ email: EMAIL, campaignId: CAMPAIGN, now: NOW, randomInt: always("recon_water") });
    // A second attempt that WOULD have drawn the jackpot, if it drew at all.
    const second = await spin({ email: EMAIL, campaignId: CAMPAIGN, now: NOW, randomInt: always("klow") });

    expect(second?.prize.id).toBe(first?.prize.id);
    expect(second?.prize.id).toBe("recon_water");
    expect(second?.alreadySpun).toBe(true);
    expect(db.rows).toHaveLength(1);
  });

  it("never hands the token out a second time", async () => {
    await spin({ email: EMAIL, campaignId: CAMPAIGN, now: NOW, randomInt: always("glow") });
    const second = await spin({ email: EMAIL, campaignId: CAMPAIGN, now: NOW, randomInt: always("klow") });

    // The cookie from the first call is how this browser carries the prize. A
    // second token would be a second bearer secret for one offer.
    expect(second?.offerToken).toBeNull();
  });

  it("does not re-roll when two requests race past the read", async () => {
    // Both calls see no existing row, both attempt the insert, and the index
    // refuses the loser. The loser must report the winner's prize — NOT retire
    // it and mint its own, which is what issueResolvedOffer would do.
    const [a, b] = await Promise.all([
      spin({ email: EMAIL, campaignId: CAMPAIGN, now: NOW, randomInt: always("recon_water") }),
      spin({ email: EMAIL, campaignId: CAMPAIGN, now: NOW, randomInt: always("klow") }),
    ]);

    expect(db.rows, "exactly one prize survives a race").toHaveLength(1);
    expect(a?.prize.id).toBe(b?.prize.id);
  });

  it("still says they span after they have spent it", async () => {
    await spin({ email: EMAIL, campaignId: CAMPAIGN, now: NOW, randomInt: always("hgh") });
    db.rows[0].redeemed_at = new Date(NOW).toISOString();

    const again = await spin({ email: EMAIL, campaignId: CAMPAIGN, now: NOW, randomInt: always("klow") });
    expect(again?.prize.id).toBe("hgh");
    expect(again?.alreadySpun).toBe(true);
    expect(db.rows).toHaveLength(1);
  });
});

describe("separating one campaign from the next", () => {
  it("lets the same person spin again in a different campaign", async () => {
    // The whole reason the campaign is in the offer key: this is a re-runnable
    // promotion, and a customer who span in Q4 is a fresh spinner in Q1.
    await spin({ email: EMAIL, campaignId: "winback_2026q4", now: NOW, randomInt: always("recon_water") });
    const next = await spin({ email: EMAIL, campaignId: "winback_2027q1", now: NOW, randomInt: always("klow") });

    expect(next?.alreadySpun).toBe(false);
    expect(next?.prize.id).toBe("klow");
    expect(db.rows).toHaveLength(2);
  });
});

describe("reading a spin back", () => {
  it("reports nothing for someone who has not span", async () => {
    expect(await readExistingSpin({ email: EMAIL, campaignId: CAMPAIGN })).toBeNull();
  });

  it("reports the wedge so a returning visitor sees the result they already got", async () => {
    await spin({ email: EMAIL, campaignId: CAMPAIGN, now: NOW, randomInt: always("cjc_ipamorelin") });

    const seen = await readExistingSpin({ email: EMAIL, campaignId: CAMPAIGN });
    expect(seen?.prize.id).toBe("cjc_ipamorelin");
    expect(seen?.sliceIndex).toBe(SPIN_PRIZES.findIndex((p) => p.id === "cjc_ipamorelin"));
    expect(seen?.offerToken).toBeNull();
  });

  it("STILL COUNTS a cycle-closed spin, so a paid order cannot buy a re-roll", async () => {
    // close_cycle no longer touches spin rows, but a row it caught before that
    // fix must not become a free draw. The index would allow the insert — it is
    // partial on `revoked_at is null and redeemed_at is null` — so this read is
    // the only thing standing between a revoked prize and a second one.
    db.rows.push({
      id: "row-old", offer_key: spinOfferKey(CAMPAIGN), email: EMAIL,
      token_hash: "h", reward_kind: "free_product", product_slug: "klow",
      percent_off: null, quantity: 1, min_subtotal_cents: 20_000,
      expires_at: new Date(NOW + 48 * 3_600_000).toISOString(),
      reserved_order_id: null,
      revoked_at: new Date(NOW - 3_600_000).toISOString(),
      redeemed_at: null,
      revoke_reason: "cycle_closed",
    } as never);

    const again = await spin({ email: EMAIL, campaignId: CAMPAIGN, now: NOW, randomInt: always("glow") });
    expect(again?.alreadySpun, "they already span").toBe(true);
    expect(again?.prize.id, "and it is the prize they won, not a fresh draw").toBe("klow");
    expect(db.inserts, "nothing was minted").toBe(0);
  });

  it("prefers a live prize over a cycle-closed one, so a support re-spin wins", async () => {
    db.rows.push({
      id: "row-old", offer_key: spinOfferKey(CAMPAIGN), email: EMAIL,
      token_hash: "h", reward_kind: "free_product", product_slug: "klow",
      percent_off: null, quantity: 1, min_subtotal_cents: 20_000,
      expires_at: new Date(NOW + 48 * 3_600_000).toISOString(),
      reserved_order_id: null, revoked_at: new Date(NOW - 3_600_000).toISOString(),
      redeemed_at: null, revoke_reason: "cycle_closed",
    } as never);
    db.rows.push({
      id: "row-new", offer_key: spinOfferKey(CAMPAIGN), email: EMAIL,
      token_hash: "h2", reward_kind: "free_product", product_slug: "semax",
      percent_off: null, quantity: 1, min_subtotal_cents: 9_900,
      expires_at: new Date(NOW + 48 * 3_600_000).toISOString(),
      reserved_order_id: null, revoked_at: null, redeemed_at: null, revoke_reason: null,
    } as never);

    const seen = await readExistingSpin({ email: EMAIL, campaignId: CAMPAIGN });
    expect(seen?.prize.id, "the live row, not the swept one").toBe("semax");
    expect(seen?.cycleClosed).toBeFalsy();
  });

  it("ignores a revoked spin, so support can hand someone a fresh one", async () => {
    await spin({ email: EMAIL, campaignId: CAMPAIGN, now: NOW, randomInt: always("kisspeptin") });
    db.rows[0].revoked_at = new Date(NOW).toISOString();

    expect(await readExistingSpin({ email: EMAIL, campaignId: CAMPAIGN })).toBeNull();
  });
});
