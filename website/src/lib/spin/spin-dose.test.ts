import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE DOSE A WINNER PICKS, AND EVERY WAY SOMEONE MIGHT TRY TO PICK A BETTER ONE.
//
// The client sends a label and nothing else — no variant id, no minimum, no
// product. So the interesting tests are not "does the happy path work" but
// "what happens when the request is a lie": a dose from another product, a dose
// that never existed, a uuid pasted in place of a label, a retired strength.
// Each must be refused, and refused WITHOUT writing anything, because a stored
// dose the till will not honour is worse than no dose at all.
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  offer_key: string;
  email: string;
  reward_kind: string;
  product_slug: string | null;
  percent_off: number | null;
  variant_id: string | null;
  min_subtotal_cents: number;
  expires_at: string;
  reserved_order_id: string | null;
  reserved_at: string | null;
  revoked_at: string | null;
  redeemed_at: string | null;
};

const db = vi.hoisted(() => ({ rows: [] as Row[], updates: 0 }));
const catalog = vi.hoisted(() => ({ disabled: new Set<string>() }));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async (slugs: string[]) => {
    const doses: Record<string, Array<{ id: string; label: string }>> = {
      "glp-1": [
        { id: "v-5", label: "5mg" }, { id: "v-10", label: "10mg" },
        { id: "v-20", label: "20mg" }, { id: "v-30", label: "30mg" },
      ],
      "hgh-gh-191": [{ id: "h-24", label: "24iu" }, { id: "h-36", label: "36iu" }],
      klow: [{ id: "k-80", label: "80mg" }],
    };
    return slugs.map((slug) => ({
      slug,
      doses: (doses[slug] ?? []).filter((dose) => !catalog.disabled.has(dose.id)),
    }));
  },
}));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table !== "customer_offers") throw new Error(`unexpected table ${table}`);
    const filters: Array<(row: Row) => boolean> = [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq(column: keyof Row, value: unknown) { filters.push((r) => r[column] === value); return chain; },
      is(column: keyof Row, value: null) { filters.push((r) => r[column] === value); return chain; },
      async maybeSingle() {
        const hit = db.rows.filter((r) => filters.every((f) => f(r)));
        return { data: hit[0] ?? null, error: null };
      },
      update(patch: Partial<Row>) {
        const apply = () => {
          const hit: Row[] = [];
          for (const r of db.rows) {
            if (filters.every((f) => f(r))) { Object.assign(r, patch); db.updates += 1; hit.push(r); }
          }
          return hit;
        };
        const upd: Record<string, unknown> = {
          eq(column: keyof Row, value: unknown) { filters.push((r) => r[column] === value); return upd; },
          is(column: keyof Row, value: null) { filters.push((r) => r[column] === value); return upd; },
          // Returns the rows it actually touched, the way PostgREST does — the
          // difference between "the guards held" and "the guards did nothing".
          select() { return { then(resolve: (v: unknown) => void) { resolve({ data: apply(), error: null }); } }; },
          then(resolve: (v: unknown) => void) { apply(); resolve({ error: null }); },
        };
        return upd;
      },
    };
    return chain;
  };
  return { supabaseAdmin: { from } };
});

const { chooseSpinDose, availableDoseRungs } = await import("@/lib/spin/spin-dose");
const { spinOfferKey } = await import("@/lib/spin/offer-key");
const { SPIN_PRIZES } = await import("@/lib/spin/prize-table");

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
const CAMPAIGN = "winback_2026q4";
const EMAIL = "lapsed@example.test";
const HOUR = 60 * 60 * 1000;

function seed(overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: "offer-1",
    offer_key: spinOfferKey(CAMPAIGN),
    email: EMAIL,
    reward_kind: "free_product",
    product_slug: "glp-1",
    percent_off: null,
    variant_id: null,
    min_subtotal_cents: 9_000,
    expires_at: new Date(NOW + 48 * HOUR).toISOString(),
    reserved_order_id: null,
    reserved_at: null,
    revoked_at: null,
    redeemed_at: null,
    ...overrides,
  };
  db.rows.push(row);
  return row;
}

const choose = (label: string, email = EMAIL) =>
  chooseSpinDose({ verifiedEmail: email, campaignId: CAMPAIGN, label, now: NOW });

beforeEach(() => {
  db.rows = [];
  db.updates = 0;
  catalog.disabled = new Set();
});

describe("recording the dose a winner chose", () => {
  it("stores the variant and that rung's minimum together", async () => {
    const row = seed();
    const result = await choose("30mg");

    expect(result).toMatchObject({ ok: true, variantId: "v-30", label: "30mg", minSubtotalCents: 17_000 });
    expect(row.variant_id).toBe("v-30");
    // The pair is the point: a variant without its minimum would let the
    // customer take the 30mg while clearing the 5mg's $90.
    expect(row.min_subtotal_cents).toBe(17_000);
  });

  it("is idempotent, so a double submit and a second tab converge", async () => {
    const row = seed();
    await choose("20mg");
    await choose("20mg");
    expect(row.variant_id).toBe("v-20");
    expect(row.min_subtotal_cents).toBe(14_500);
  });

  it("lets a customer change their mind while the prize is still theirs", async () => {
    const row = seed();
    await choose("30mg");
    await choose("10mg");
    expect(row.variant_id).toBe("v-10");
    expect(row.min_subtotal_cents).toBe(10_500);
  });
});

describe("refusing a dose that is not really on offer", () => {
  it("refuses a strength this prize does not sell", async () => {
    const row = seed();
    expect(await choose("80mg")).toMatchObject({ ok: false, reason: "unknown_dose" });
    expect(row.variant_id, "nothing written").toBeNull();
    expect(db.updates).toBe(0);
  });

  it("refuses ANOTHER PRODUCT'S dose, even a real one", async () => {
    // 24iu is a genuine HGH strength. On a GLP-1 prize it is not.
    const row = seed();
    expect(await choose("24iu")).toMatchObject({ ok: false, reason: "unknown_dose" });
    expect(row.min_subtotal_cents, "and the minimum is untouched").toBe(9_000);
  });

  it("refuses a raw variant id pasted in place of a label", async () => {
    seed();
    expect(await choose("v-30")).toMatchObject({ ok: false, reason: "unknown_dose" });
    expect(db.updates).toBe(0);
  });

  it("refuses an empty or junk label", async () => {
    seed();
    expect(await choose("")).toMatchObject({ ok: false, reason: "unknown_dose" });
    expect(await choose("../../etc/passwd")).toMatchObject({ ok: false, reason: "unknown_dose" });
    expect(db.updates).toBe(0);
  });

  it("refuses a rung the admin has retired, rather than storing a dead dose", async () => {
    const row = seed();
    catalog.disabled = new Set(["v-30"]);
    expect(await choose("30mg")).toMatchObject({ ok: false, reason: "dose_unavailable" });
    expect(row.variant_id).toBeNull();
  });

  it("refuses any dose on a single-dose prize", async () => {
    seed({ product_slug: "klow", min_subtotal_cents: 20_000 });
    expect(await choose("80mg")).toMatchObject({ ok: false, reason: "no_choice" });
    expect(db.updates).toBe(0);
  });
});

describe("refusing to touch a prize that is not available to change", () => {
  it("refuses another customer's prize", async () => {
    const row = seed();
    expect(await choose("30mg", "stranger@example.test")).toMatchObject({ ok: false, reason: "not_found" });
    expect(row.variant_id).toBeNull();
  });

  it("refuses an expired prize", async () => {
    seed({ expires_at: new Date(NOW - HOUR).toISOString() });
    expect(await choose("30mg")).toMatchObject({ ok: false, reason: "not_found" });
    expect(db.updates).toBe(0);
  });

  it("refuses a redeemed prize", async () => {
    seed({ redeemed_at: new Date(NOW - HOUR).toISOString() });
    expect(await choose("30mg")).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("refuses a revoked prize", async () => {
    seed({ revoked_at: new Date(NOW - HOUR).toISOString() });
    expect(await choose("30mg")).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("REFUSES WHILE A CHECKOUT IS HOLDING IT — the change-your-mind race", async () => {
    // quoteOrder priced one dose; customer_offer_reserve re-checks expiry,
    // revocation, redemption and the email binding, but NOT the dose or the
    // minimum. A write here would ship the old dose against the new minimum.
    const row = seed({ reserved_order_id: "order-9", reserved_at: new Date(NOW - 60_000).toISOString() });
    expect(await choose("30mg")).toMatchObject({ ok: false, reason: "held_by_checkout" });
    expect(row.variant_id).toBeNull();
    expect(row.min_subtotal_cents).toBe(9_000);
  });

  it("STILL refuses when the hold is stale but the flag is set — fails closed", async () => {
    // The read-side hold has lapsed, so the first guard lets this through. The
    // write's `reserved_order_id is null` then refuses it, matches no rows, and
    // — because the update reports the rows it touched — that is reported as a
    // refusal rather than a silent success. Failing closed is right: an
    // abandoned hold is cleaned up elsewhere, and guessing here reopens exactly
    // the race these guards exist for.
    const row = seed({ reserved_order_id: "order-9", reserved_at: new Date(NOW - 2 * HOUR).toISOString() });
    const result = await choose("30mg");
    expect(result).toMatchObject({ ok: false, reason: "held_by_checkout" });
    expect(row.variant_id, "and nothing was written").toBeNull();
    expect(row.min_subtotal_cents).toBe(9_000);
  });
});

describe("the doses offered to the customer", () => {
  const glp1 = SPIN_PRIZES.find((prize) => prize.id === "glp_1")!;

  it("offers every rung, cheapest first, with its own minimum", async () => {
    const rungs = await availableDoseRungs(glp1);
    expect(rungs.map((rung) => [rung.label, rung.minSubtotalCents])).toEqual([
      ["5mg", 9_000], ["10mg", 10_500], ["20mg", 14_500], ["30mg", 17_000],
    ]);
    expect(rungs.map((rung) => rung.variantId)).toEqual(["v-5", "v-10", "v-20", "v-30"]);
  });

  it("drops a retired rung rather than offering something the till would refuse", async () => {
    catalog.disabled = new Set(["v-20"]);
    const rungs = await availableDoseRungs(glp1);
    expect(rungs.map((rung) => rung.label)).toEqual(["5mg", "10mg", "30mg"]);
  });

  it("offers nothing for a single-dose prize", async () => {
    const klow = SPIN_PRIZES.find((prize) => prize.id === "klow")!;
    expect(await availableDoseRungs(klow)).toEqual([]);
  });
});
