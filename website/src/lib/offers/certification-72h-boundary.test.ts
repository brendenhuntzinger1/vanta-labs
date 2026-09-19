import { describe, expect, it, vi } from "vitest";

import { SPIN_TTL_DAYS } from "@/lib/spin/prize-table";

// ---------------------------------------------------------------------------
// SECTION E — THE PRIZE LIVES EXACTLY 72 HOURS, AND THE CLOCK STARTS AT MINT.
//
// Re-established against the CURRENT tree rather than inherited from an earlier
// certification, because the figure is load-bearing in three places that can
// drift apart: the number stamped on the row, the filter that refuses a stale
// row, and the countdown the customer reads.
//
// 72 hours = 259,200 seconds = 259,200,000 milliseconds.
//
// THE TWO CLOCKS ARE DIFFERENT AND MUST NOT BE CONFUSED. The spin LINK lives
// 30 days (SPIN_TOKEN_TTL_MS) because people open marketing mail late; the
// PRIZE lives 72 hours from the moment it is drawn. A test that checked the
// link's clock would pass while the prize's clock was wrong.
// ---------------------------------------------------------------------------

const SEVENTY_TWO_HOURS_MS = 259_200_000;
const SEVENTY_TWO_HOURS_S = 259_200;

describe("the constant itself", () => {
  it("is exactly 72 hours, expressed as days", () => {
    expect(SPIN_TTL_DAYS).toBe(3);
    expect(SPIN_TTL_DAYS * 24 * 60 * 60 * 1000).toBe(SEVENTY_TWO_HOURS_MS);
    expect(SPIN_TTL_DAYS * 24 * 60 * 60).toBe(SEVENTY_TWO_HOURS_S);
  });

  it("is NOT the spin link's own lifetime, which is far longer", async () => {
    const { SPIN_TOKEN_TTL_MS } = await import("@/lib/spin/spin-token");
    expect(SPIN_TOKEN_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(SPIN_TOKEN_TTL_MS).toBeGreaterThan(SEVENTY_TWO_HOURS_MS);
  });
});

describe("the clock starts when the prize is MINTED, not when the link was sent", () => {
  it("stamps expires_at exactly 72h after issue", async () => {
    const issuedAt = Date.parse("2026-09-19T00:00:00.000Z");
    const expiresAt = issuedAt + SPIN_TTL_DAYS * 24 * 60 * 60 * 1000;
    expect(new Date(expiresAt).toISOString()).toBe("2026-09-22T00:00:00.000Z");
    expect(expiresAt - issuedAt).toBe(SEVENTY_TWO_HOURS_MS);
  });

  it("and that is literally how spin-service stamps the row", async () => {
    // Pinned against the source so the arithmetic above is the store's, not
    // the test's. `now` here is the moment the prize is DRAWN — the clock
    // cannot start at the send, the click or the page load.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const service = readFileSync(join(process.cwd(), "src", "lib", "spin", "spin-service.ts"), "utf8");
    expect(service).toContain("const expiresAt = new Date(now + SPIN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();");
  });
});

// ---------------------------------------------------------------------------
// The boundary, walked one second at a time, through the REAL read filter.
// peekCustomerOffer takes an injectable `now`, so these are exact rather than
// approximate — no sleeping, no flake.
// ---------------------------------------------------------------------------
describe("the boundary, through the real server-side filter", () => {
  const ISSUED = Date.parse("2026-09-19T00:00:00.000Z");
  const EXPIRES = ISSUED + SEVENTY_TWO_HOURS_MS;
  const TOKEN = "boundary-token";

  /** The row as customer_offers holds it, keyed by the real token hash. */
  function mockRow() {
    return {
      id: "offer-boundary",
      offer_key: "spin:winback_2026q4",
      email: "boundary@example.test",
      reward_kind: "free_product",
      product_slug: "ghk-cu",
      gift_items: null,
      percent_off: null,
      max_discount_cents: null,
      quantity: 1,
      variant_id: null,
      min_subtotal_cents: 7500,
      expires_at: new Date(EXPIRES).toISOString(),
      reserved_order_id: null,
      redeemed_at: null,
      revoked_at: null,
    };
  }

  async function peekAt(now: number) {
    vi.resetModules();
    vi.doMock("@/lib/supabase-server", () => {
      const chain = () => {
        const self: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "order", "limit", "not", "is", "gte", "lte", "neq", "ilike"]) self[m] = () => self;
        self.maybeSingle = async () => ({ data: mockRow(), error: null });
        self.single = async () => ({ data: mockRow(), error: null });
        self.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r);
        return self;
      };
      const client = { from: () => chain(), rpc: async () => ({ data: null, error: null }) };
      return { supabaseAdmin: client, createServerClient: () => client };
    });
    const { peekCustomerOffer } = await import("@/lib/offers/customer-offers");
    return peekCustomerOffer({ token: TOKEN, email: "boundary@example.test", now });
  }

  it("just issued — live", async () => {
    expect(await peekAt(ISSUED)).not.toBeNull();
  });

  it("71h 59m 59s — live", async () => {
    expect(await peekAt(ISSUED + SEVENTY_TWO_HOURS_MS - 1000)).not.toBeNull();
  });

  it("90 seconds remaining — live", async () => {
    expect(await peekAt(EXPIRES - 90_000)).not.toBeNull();
  });

  it("1 second remaining — live", async () => {
    expect(await peekAt(EXPIRES - 1000)).not.toBeNull();
  });

  it("1 millisecond remaining — still live", async () => {
    expect(await peekAt(EXPIRES - 1)).not.toBeNull();
  });

  it("THE EXACT BOUNDARY — dead, because the comparison is <=", async () => {
    // A prize is dead ON its stroke, not a moment after. That is what stops
    // the 72 hours becoming 72 hours plus one round trip.
    expect(await peekAt(EXPIRES), "the prize outlived its own stroke").toBeNull();
  });

  it("1 millisecond past — dead", async () => {
    expect(await peekAt(EXPIRES + 1)).toBeNull();
  });

  it("1 second past — dead", async () => {
    expect(await peekAt(EXPIRES + 1000)).toBeNull();
  });

  it("a day past — dead, and no refresh or stale cart can resurrect it", async () => {
    // The filter is a pure function of the row and the clock; nothing the
    // browser holds is an input, so a stale cart, a cached page and a
    // re-submitted checkout all get the same answer.
    expect(await peekAt(EXPIRES + 86_400_000)).toBeNull();
  });
});

describe("the SQL enforces the same instant, so the reserve cannot honour what the read refused", () => {
  it("customer_offer_reserve returns nothing once expires_at has passed", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sql = readFileSync(join(process.cwd(), "src", "lib", "sql", "customer-offers.sql"), "utf8");
    const fn = sql.slice(sql.indexOf("create or replace function public.customer_offer_reserve"));
    // Same comparison as the read: dead on the stroke.
    expect(fn.slice(0, 1400)).toContain("if v_offer.expires_at <= now() then return; end if;");
  });
});
