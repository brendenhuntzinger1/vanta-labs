import { beforeEach, describe, expect, it } from "vitest";

import { __resetColumnTierCache, selectColumnTier } from "@/lib/storefront-offers";

// ---------------------------------------------------------------------------
// THE MIGRATION-TOLERANT COLUMN PROBE MUST NOT RE-PROBE ON EVERY REQUEST.
//
// publicCoupons selects the widest column list first and steps down when the
// database has not run an optional migration. That fallback is correct and
// stays: an install that has run none of the migrations still gets a working
// offers bar.
//
// What it did NOT do is remember the answer. Production has never run
// coupon-storefront-fields.sql, so tier 1 asks for coupons.storefront_headline
// on EVERY request and Postgres answers 42703 every time -- 2,350 guaranteed
// 400s in 24 hours, one per page load, for a column that will not appear until
// somebody runs a migration.
//
// The tier that worked is now remembered for the life of the process. The
// probe still happens -- once per cold start -- so a migration applied later is
// still picked up on the next deploy or the next cold lambda, and the fallback
// behaviour itself is unchanged.
// ---------------------------------------------------------------------------

const TIERS = ["wide", "middle", "narrow"] as const;

/** Records which tiers were actually attempted, in order. */
function probe(succeedsOn: string) {
  const attempts: string[] = [];
  const attempt = async (columns: string) => {
    attempts.push(columns);
    return columns === succeedsOn
      ? ({ ok: true, value: `rows-from-${columns}` } as const)
      : ({ ok: false, error: new Error(`column ${columns} does not exist`) } as const);
  };
  return { attempts, attempt };
}

beforeEach(() => {
  __resetColumnTierCache();
});

describe("selectColumnTier", () => {
  it("steps down to the first tier the database accepts", async () => {
    const { attempts, attempt } = probe("middle");
    const result = await selectColumnTier(TIERS, attempt);

    expect(result).toEqual({ ok: true, value: "rows-from-middle" });
    expect(attempts).toEqual(["wide", "middle"]);
  });

  it("remembers that tier, so the next call spends ONE request, not three", async () => {
    // The whole point. Without this the doomed "wide" probe repeats on every
    // request for as long as the migration is unrun.
    const first = probe("middle");
    await selectColumnTier(TIERS, first.attempt);

    const second = probe("middle");
    const result = await selectColumnTier(TIERS, second.attempt);

    expect(result).toEqual({ ok: true, value: "rows-from-middle" });
    expect(second.attempts).toEqual(["middle"]);
  });

  it("re-probes from the widest tier when the remembered one stops working", async () => {
    // A migration applied after the cache warmed, or a column dropped. Caching
    // must not be a one-way door that pins the store to a narrow tier for ever.
    const first = probe("middle");
    await selectColumnTier(TIERS, first.attempt);

    const afterMigration = probe("wide");
    const result = await selectColumnTier(TIERS, afterMigration.attempt);

    expect(result).toEqual({ ok: true, value: "rows-from-wide" });
    // "middle" first because it is remembered, then the full ladder from the top.
    expect(afterMigration.attempts).toEqual(["middle", "wide"]);
  });

  it("reports the last failure when no tier is accepted", async () => {
    const { attempts, attempt } = probe("none-of-them");
    const result = await selectColumnTier(TIERS, attempt);

    expect(result.ok).toBe(false);
    expect(attempts).toEqual(["wide", "middle", "narrow"]);
  });

  it("does not remember a tier that never succeeded", async () => {
    // Otherwise a total outage would poison the cache and pin every later
    // request to whichever tier happened to be tried last.
    const failed = probe("none-of-them");
    await selectColumnTier(TIERS, failed.attempt);

    const recovered = probe("wide");
    await selectColumnTier(TIERS, recovered.attempt);
    expect(recovered.attempts).toEqual(["wide"]);
  });
});
