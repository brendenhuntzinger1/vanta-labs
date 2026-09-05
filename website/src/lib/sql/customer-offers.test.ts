import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSuiteDatabase } from "@/lib/e2e/suite-database";

// ---------------------------------------------------------------------------
// THE ABUSE PROOF.
//
// A one-time offer that grants a PHYSICAL PRODUCT is worth attacking, and every
// way it can be attacked is a way somebody gets free vials:
//
//   * forward the link to a friend, or post it publicly;
//   * open two tabs and check out twice at the same instant;
//   * order, receive the vial, refund, and redeem again;
//   * wait for it to expire and use it anyway;
//   * get mailed twice and hold two live tokens.
//
// None of those can be proved against a mock: a mocked database has no
// concurrency to be wrong about, no unique index to violate, and no clock. So
// this runs the SHIPPED functions, parsed out of the migration file that
// actually deploys, against a real Postgres — including from genuinely parallel
// connections firing at the same instant.
//
// The refund case is the one to read carefully. promotion_redemption_claims
// deliberately RELEASES on refund; this deliberately does not, and the test
// below is what stops somebody "fixing" that inconsistency later.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  process.stderr.write(
    "[customer-offers] SKIPPED — set VANTA_TEST_DATABASE_URL to a throwaway Postgres to run it.\n",
  );
}

const MIGRATION = path.resolve(__dirname, "customer-offers.sql");

/** Just enough of `orders` for the reserve function's status checks to resolve. */
const ORDERS_STUB = `
  create table if not exists public.orders (
    order_id text primary key,
    customer_email text,
    payment_status text not null default 'pending_payment'
  );
`;

/** And enough of email_automations for the offer_key column to attach to. */
const AUTOMATIONS_STUB = `
  create table if not exists public.email_automations (
    key text primary key
  );
`;

const ENSURE_SERVICE_ROLE = `
  do $$ begin
    create role service_role nologin noinherit bypassrls;
  exception when duplicate_object then null; end $$;
`;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

describeDb("customer_offers", () => {
  let dbUrl: string;
  let client: Client;

  beforeAll(async () => {
    dbUrl = await createSuiteDatabase(DATABASE_URL!, "customer_offers");
    client = new Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(ENSURE_SERVICE_ROLE);
    await client.query("create extension if not exists pgcrypto");
    await client.query(ORDERS_STUB);
    await client.query(AUTOMATIONS_STUB);
    await client.query(readFileSync(MIGRATION, "utf8"));
  }, 120_000);

  afterAll(async () => {
    await client?.end().catch(() => {});
  });

  beforeEach(async () => {
    await client.query("truncate public.customer_offers");
    await client.query("truncate public.orders");
  });

  /** Insert one live offer and return its token. */
  async function issue(email: string, opts?: { expiresInHours?: number; minCents?: number }) {
    const token = `token-${Math.random().toString(36).slice(2)}-${email}`;
    await client.query(
      `insert into public.customer_offers (offer_key, token_hash, email, product_slug, min_subtotal_cents, expires_at)
       values ('winback_60_free_ghkcu', $1, $2, 'ghk-cu', $3, now() + make_interval(hours => $4))`,
      [hash(token), email.toLowerCase(), opts?.minCents ?? 6000, opts?.expiresInHours ?? 24],
    );
    return token;
  }

  const reserve = async (token: string, orderId: string, email: string) =>
    (await client.query("select * from public.customer_offer_reserve($1, $2, $3)", [hash(token), orderId, email])).rows;

  const redeem = async (orderId: string) =>
    (await client.query("select public.customer_offer_redeem($1) as ok", [orderId])).rows[0].ok;

  const order = async (orderId: string, status: string) =>
    client.query(
      "insert into public.orders (order_id, payment_status) values ($1, $2) on conflict (order_id) do update set payment_status = excluded.payment_status",
      [orderId, status],
    );

  it("reserves for the address it was issued to", async () => {
    const token = await issue("buyer@example.test");
    expect(await reserve(token, "order-1", "buyer@example.test")).toHaveLength(1);
  });

  it("is case-insensitive about the address, as every caller lowercases it", async () => {
    const token = await issue("buyer@example.test");
    expect(await reserve(token, "order-1", "  Buyer@Example.TEST ")).toHaveLength(1);
  });

  it("REFUSES A FORWARDED LINK opened by somebody else", async () => {
    // The single most likely abuse: the recipient posts the link publicly.
    const token = await issue("buyer@example.test");
    expect(await reserve(token, "order-1", "stranger@example.test")).toHaveLength(0);
  });

  it("refuses the same person checking out under a different address", async () => {
    const token = await issue("buyer@example.test");
    expect(await reserve(token, "order-1", "buyer+alt@example.test")).toHaveLength(0);
  });

  it("refuses an unknown token", async () => {
    expect(await reserve("never-issued", "order-1", "buyer@example.test")).toHaveLength(0);
  });

  it("refuses an expired offer", async () => {
    const token = await issue("buyer@example.test", { expiresInHours: -1 });
    expect(await reserve(token, "order-1", "buyer@example.test")).toHaveLength(0);
  });

  it("refuses a revoked offer", async () => {
    const token = await issue("buyer@example.test");
    await client.query("update public.customer_offers set revoked_at = now()");
    expect(await reserve(token, "order-1", "buyer@example.test")).toHaveLength(0);
  });

  it("ONE PERSON CANNOT HOLD TWO LIVE OFFERS for the same campaign", async () => {
    // The partial unique index. Without it a re-run of the sweep mints a second
    // valid token and that customer gets two free vials.
    await issue("buyer@example.test");
    await expect(issue("buyer@example.test")).rejects.toThrow(/duplicate key|unique/i);
  });

  it("allows a deliberate reissue after revocation", async () => {
    await issue("buyer@example.test");
    await client.query("update public.customer_offers set revoked_at = now()");
    await expect(issue("buyer@example.test")).resolves.toBeTruthy();
  });

  it("A REDEEMED OFFER DOES NOT BLOCK THE NEXT LAPSE'S GIFT", async () => {
    // The customer took the free vial, bought again, and went quiet for another
    // sixty days. The next win-back promises a gift; the index must let it be
    // minted. Before the predicate excluded redeemed rows, this insert failed
    // and the customer was mailed the promise with no token behind it.
    const token = await issue("buyer@example.test");
    await order("order-1", "pending_payment");
    expect(await reserve(token, "order-1", "buyer@example.test")).toHaveLength(1);
    expect(await redeem("order-1")).toBe(true);

    await expect(issue("buyer@example.test")).resolves.toBeTruthy();
    // And the redeemed one is still on record as redeemed — history, not a live offer.
    const { rows } = await client.query(
      "select count(*)::int as n from public.customer_offers where email = 'buyer@example.test' and redeemed_at is not null",
    );
    expect(rows[0].n).toBe(1);
  });

  it("an EXPIRED offer still occupies the slot until it is retired", async () => {
    // The TS side (issueCustomerOffer) retires an expired row before it retries
    // the insert. The index itself cannot see a clock, so it must refuse here;
    // the retire-then-retry is what makes the reissue work.
    await issue("buyer@example.test", { expiresInHours: -1 });
    await expect(issue("buyer@example.test")).rejects.toThrow(/duplicate key|unique/i);
    await client.query("update public.customer_offers set revoked_at = now() where expires_at <= now()");
    await expect(issue("buyer@example.test")).resolves.toBeTruthy();
  });

  describe("double spend", () => {
    it("holds the offer against a second, concurrent checkout", async () => {
      const token = await issue("buyer@example.test");
      expect(await reserve(token, "order-1", "buyer@example.test")).toHaveLength(1);
      expect(await reserve(token, "order-2", "buyer@example.test")).toHaveLength(0);
    });

    it("lets the SAME order ask again, which is what a checkout replay is", async () => {
      const token = await issue("buyer@example.test");
      expect(await reserve(token, "order-1", "buyer@example.test")).toHaveLength(1);
      expect(await reserve(token, "order-1", "buyer@example.test")).toHaveLength(1);
    });

    it("survives genuinely parallel connections — exactly one wins", async () => {
      // Two tabs, one instant. Sequential awaits would prove nothing, so these
      // are separate connections firing together; without the advisory lock in
      // customer_offer_reserve both read "free" and both win.
      const token = await issue("buyer@example.test");
      const clients = await Promise.all(
        [0, 1, 2, 3].map(async () => {
          const c = new Client({ connectionString: dbUrl });
          await c.connect();
          return c;
        }),
      );
      try {
        const results = await Promise.all(
          clients.map((c, i) =>
            c.query("select * from public.customer_offer_reserve($1, $2, $3)", [
              hash(token), `race-order-${i}`, "buyer@example.test",
            ]),
          ),
        );
        const winners = results.filter((r) => r.rows.length > 0);
        expect(winners, "more than one checkout was granted the same free unit").toHaveLength(1);
      } finally {
        await Promise.all(clients.map((c) => c.end().catch(() => {})));
      }
    });

    it("releases the hold once the holding order dies", async () => {
      const token = await issue("buyer@example.test");
      await reserve(token, "order-1", "buyer@example.test");
      await order("order-1", "cancelled");
      expect(await reserve(token, "order-2", "buyer@example.test")).toHaveLength(1);
    });

    it("a token held by an order that PAID is spent even after the hold ages out", async () => {
      // The redeem step after payment can die; the money still moved. Age the
      // hold past the 30-minute window and try again from a second checkout.
      const token = await issue("buyer@example.test");
      expect(await reserve(token, "order-1", "buyer@example.test")).toHaveLength(1);
      await order("order-1", "paid");
      await client.query("update public.customer_offers set reserved_at = now() - interval '2 hours' where reserved_order_id = 'order-1'");
      expect(await reserve(token, "order-2", "buyer@example.test")).toHaveLength(0);
      // ...while the paying order itself may still replay.
      expect(await reserve(token, "order-1", "buyer@example.test")).toHaveLength(1);
    });

    it("an aged-out hold by an order that never paid is released as before", async () => {
      const token = await issue("buyer@example.test");
      await reserve(token, "order-1", "buyer@example.test");
      await client.query("update public.customer_offers set reserved_at = now() - interval '2 hours' where reserved_order_id = 'order-1'");
      expect(await reserve(token, "order-2", "buyer@example.test")).toHaveLength(1);
    });
  });

  describe("redemption is permanent", () => {
    it("marks the reserving order as the redeemer", async () => {
      const token = await issue("buyer@example.test");
      await reserve(token, "order-1", "buyer@example.test");
      expect(await redeem("order-1")).toBe(true);
      const { rows } = await client.query("select redeemed_order_id, redeemed_at from public.customer_offers");
      expect(rows[0].redeemed_order_id).toBe("order-1");
      expect(rows[0].redeemed_at).toBeTruthy();
    });

    it("cannot be redeemed twice, so the timestamp stays true", async () => {
      const token = await issue("buyer@example.test");
      await reserve(token, "order-1", "buyer@example.test");
      expect(await redeem("order-1")).toBe(true);
      expect(await redeem("order-1")).toBe(false);
    });

    it("REFUNDING THE ORDER DOES NOT HAND THE OFFER BACK", async () => {
      // THE ONE THAT MATTERS. A refunded order has usually already shipped. If
      // a refund released the offer, a customer could order, receive a free
      // vial, refund, and redeem again for as long as they cared to.
      //
      // This is a DELIBERATE divergence from promotion_redemption_claims, which
      // releases on refund and says so in its header. Do not "fix" the
      // inconsistency — this test is why.
      const token = await issue("buyer@example.test");
      await reserve(token, "order-1", "buyer@example.test");
      await redeem("order-1");
      await order("order-1", "refunded");
      expect(await reserve(token, "order-2", "buyer@example.test")).toHaveLength(0);
    });

    it("cancelling a redeemed order does not hand it back either", async () => {
      const token = await issue("buyer@example.test");
      await reserve(token, "order-1", "buyer@example.test");
      await redeem("order-1");
      await order("order-1", "cancelled");
      expect(await reserve(token, "order-2", "buyer@example.test")).toHaveLength(0);
    });

    it("release refuses to touch a redeemed offer", async () => {
      const token = await issue("buyer@example.test");
      await reserve(token, "order-1", "buyer@example.test");
      await redeem("order-1");
      const { rows } = await client.query("select public.customer_offer_release($1) as ok", ["order-1"]);
      expect(rows[0].ok).toBe(false);
    });

    it("release DOES drop an unpaid checkout's hold", async () => {
      const token = await issue("buyer@example.test");
      await reserve(token, "order-1", "buyer@example.test");
      const { rows } = await client.query("select public.customer_offer_release($1) as ok", ["order-1"]);
      expect(rows[0].ok).toBe(true);
      expect(await reserve(token, "order-2", "buyer@example.test")).toHaveLength(1);
    });

    it("redeem does nothing for an order that reserved nothing", async () => {
      await issue("buyer@example.test");
      expect(await redeem("some-other-order")).toBe(false);
    });
  });

  describe("reward shapes", () => {
    // Two kinds of gift now share this table, and the constraint is what stops
    // a half-described one from ever being written: a product gift with no
    // product would grant nothing at checkout and still look valid in every
    // report, which is the quiet failure the NOT NULL used to prevent.
    it("stores a shipping gift with no product", async () => {
      const token = `ship-${Math.random().toString(36).slice(2)}`;
      await client.query(
        `insert into public.customer_offers (offer_key, token_hash, email, reward_kind, product_slug, min_subtotal_cents, expires_at)
         values ('winback_60_free_shipping', $1, $2, 'free_shipping', null, 3500, now() + interval '24 hours')`,
        [hash(token), "buyer@example.test"],
      );
      const rows = await reserve(token, "order-ship", "buyer@example.test");
      expect(rows).toHaveLength(1);
      expect(rows[0].reward_kind).toBe("free_shipping");
      expect(rows[0].product_slug).toBeNull();
    });

    it("stores a percentage-only gift with no product and a rate", async () => {
      await client.query(
        `insert into public.customer_offers (offer_key, token_hash, email, reward_kind, product_slug, percent_off, min_subtotal_cents, expires_at)
         values ('winback_60_percent_15', $1, 'p@example.test', 'percent', null, 15, 3500, now() + interval '1 day')`,
        [hash("pct-token")],
      );
      const { rows } = await client.query("select reward_kind, percent_off from public.customer_offers where email = 'p@example.test'");
      expect(rows[0].reward_kind).toBe("percent");
      expect(Number(rows[0].percent_off)).toBe(15);
    });

    it("stores a product-plus-percentage gift, and refuses it without either half", async () => {
      await client.query(
        `insert into public.customer_offers (offer_key, token_hash, email, reward_kind, product_slug, percent_off, min_subtotal_cents, expires_at)
         values ('winback_60_bac_water_10', $1, 'combo@example.test', 'free_product_percent', 'bacteriostatic-water', 10, 3500, now() + interval '1 day')`,
        [hash("combo-token")],
      );
      const { rows } = await client.query("select reward_kind, product_slug, percent_off from public.customer_offers where email = 'combo@example.test'");
      expect(rows[0]).toMatchObject({ reward_kind: "free_product_percent", product_slug: "bacteriostatic-water" });
      await expect(client.query(
        `insert into public.customer_offers (offer_key, token_hash, email, reward_kind, product_slug, percent_off, min_subtotal_cents, expires_at)
         values ('winback_60_bac_water_10', $1, 'combo2@example.test', 'free_product_percent', null, 10, 3500, now() + interval '1 day')`,
        [hash("combo-bad-1")],
      )).rejects.toThrow(/check constraint/i);
      await expect(client.query(
        `insert into public.customer_offers (offer_key, token_hash, email, reward_kind, product_slug, percent_off, min_subtotal_cents, expires_at)
         values ('winback_60_bac_water_10', $1, 'combo3@example.test', 'free_product_percent', 'bacteriostatic-water', null, 3500, now() + interval '1 day')`,
        [hash("combo-bad-2")],
      )).rejects.toThrow(/check constraint/i);
    });

    it("refuses a percentage-only gift that names a product or has no rate", async () => {
      await expect(client.query(
        `insert into public.customer_offers (offer_key, token_hash, email, reward_kind, product_slug, percent_off, min_subtotal_cents, expires_at)
         values ('winback_60_percent_15', $1, 'p2@example.test', 'percent', 'ghk-cu', 15, 3500, now() + interval '1 day')`,
        [hash("pct-bad-1")],
      )).rejects.toThrow(/check constraint/i);
      await expect(client.query(
        `insert into public.customer_offers (offer_key, token_hash, email, reward_kind, product_slug, percent_off, min_subtotal_cents, expires_at)
         values ('winback_60_percent_15', $1, 'p3@example.test', 'percent', null, null, 3500, now() + interval '1 day')`,
        [hash("pct-bad-2")],
      )).rejects.toThrow(/check constraint/i);
    });

    it("refuses a product gift with no product", async () => {
      await expect(client.query(
        `insert into public.customer_offers (offer_key, token_hash, email, reward_kind, product_slug, min_subtotal_cents, expires_at)
         values ('winback_60_free_ghkcu', $1, $2, 'free_product', null, 6000, now() + interval '24 hours')`,
        [hash("bad-product"), "buyer@example.test"],
      )).rejects.toThrow(/customer_offers_reward_shape|violates check/i);
    });

    it("refuses a shipping gift that names a product", async () => {
      await expect(client.query(
        `insert into public.customer_offers (offer_key, token_hash, email, reward_kind, product_slug, min_subtotal_cents, expires_at)
         values ('winback_60_free_shipping', $1, $2, 'free_shipping', 'ghk-cu', 3500, now() + interval '24 hours')`,
        [hash("bad-shipping"), "buyer@example.test"],
      )).rejects.toThrow(/customer_offers_reward_shape|violates check/i);
    });

    it("defaults an un-migrated insert to the kind that used to be the only one", async () => {
      // Every row written before reward_kind existed was a product gift, and
      // the default is what keeps those rows meaning what they meant.
      const token = `legacy-${Math.random().toString(36).slice(2)}`;
      await client.query(
        `insert into public.customer_offers (offer_key, token_hash, email, product_slug, min_subtotal_cents, expires_at)
         values ('winback_60_free_ghkcu', $1, $2, 'ghk-cu', 6000, now() + interval '24 hours')`,
        [hash(token), "buyer@example.test"],
      );
      const rows = await reserve(token, "order-legacy", "buyer@example.test");
      expect(rows[0].reward_kind).toBe("free_product");
    });

    it("one person can hold a product gift AND a shipping gift", async () => {
      // The unique index is per (offer_key, email), not per address — two
      // different campaigns may each mail the same person once.
      await issue("buyer@example.test");
      await expect(client.query(
        `insert into public.customer_offers (offer_key, token_hash, email, reward_kind, product_slug, min_subtotal_cents, expires_at)
         values ('winback_60_free_shipping', $1, $2, 'free_shipping', null, 3500, now() + interval '24 hours')`,
        [hash("both-kinds"), "buyer@example.test"],
      )).resolves.toBeTruthy();
    });
  });

  describe("a paid order closes the retention cycle", () => {
    // A retention offer exists to recover ONE purchase. Once the customer has
    // paid, every other unredeemed gift from that cycle is dead: they cannot
    // collect the day-30, day-40 and day-50 gifts and spend each on a later
    // order. Expiry stays as the second layer, not the mechanism.
    async function issueKind(email: string, offerKey: string, kind: string, extra: { slug?: string | null; percent?: number | null } = {}) {
      const token = `token-${offerKey}-${Math.random().toString(36).slice(2)}`;
      await client.query(
        `insert into public.customer_offers (offer_key, token_hash, email, reward_kind, product_slug, percent_off, min_subtotal_cents, expires_at)
         values ($1, $2, $3, $4, $5, $6, 3500, now() + interval '30 days')`,
        [offerKey, hash(token), email.toLowerCase(), kind, extra.slug ?? null, extra.percent ?? null],
      );
      return token;
    }
    const closeCycle = async (orderId: string, email: string) =>
      (await client.query("select public.customer_offer_close_cycle($1, $2) as closed", [orderId, email])).rows[0].closed;
    const rowsFor = async (email: string) =>
      (await client.query(
        "select offer_key, redeemed_at, revoked_at, revoke_reason, closed_by_order_id from public.customer_offers where email = $1 order by offer_key",
        [email],
      )).rows;

    it("kills the unused day-30 gift when the day-40 gift is redeemed", async () => {
      const day30 = await issueKind("buyer@example.test", "winback_60_free_shipping", "free_shipping");
      const day40 = await issueKind("buyer@example.test", "winback_60_bac_water_10", "free_product_percent", { slug: "bacteriostatic-water", percent: 10 });
      expect(await reserve(day40, "order-40", "buyer@example.test")).toHaveLength(1);
      expect(await redeem("order-40")).toBe(true);
      expect(await closeCycle("order-40", "buyer@example.test")).toBe(1);

      const rows = await rowsFor("buyer@example.test");
      const shipping = rows.find((r) => r.offer_key === "winback_60_free_shipping");
      const bac = rows.find((r) => r.offer_key === "winback_60_bac_water_10");
      expect(shipping?.revoked_at, "the ignored day-30 gift should be dead").not.toBeNull();
      expect(shipping?.revoke_reason).toBe("cycle_closed");
      expect(shipping?.closed_by_order_id).toBe("order-40");
      expect(bac?.redeemed_at, "the gift that was actually used stays redeemed").not.toBeNull();
      expect(bac?.revoked_at, "a redeemed gift is history, not a revocation").toBeNull();
      // And the dead token can no longer be spent, even on a later order.
      expect(await reserve(day30, "order-later", "buyer@example.test")).toHaveLength(0);
    });

    it("a purchase WITHOUT clicking the email still closes the cycle", async () => {
      const day30 = await issueKind("buyer@example.test", "winback_60_free_shipping", "free_shipping");
      // No reservation at all: the customer typed the URL and paid full price.
      expect(await closeCycle("order-plain", "buyer@example.test")).toBe(1);
      expect(await reserve(day30, "order-next", "buyer@example.test")).toHaveLength(0);
      const [row] = await rowsFor("buyer@example.test");
      expect(row.revoke_reason).toBe("cycle_closed");
      expect(row.closed_by_order_id).toBe("order-plain");
    });

    it("never touches another customer's gifts", async () => {
      await issueKind("buyer@example.test", "winback_60_free_shipping", "free_shipping");
      const other = await issueKind("other@example.test", "winback_60_free_shipping", "free_shipping");
      expect(await closeCycle("order-1", "buyer@example.test")).toBe(1);
      expect(await reserve(other, "order-other", "other@example.test")).toHaveLength(1);
    });

    it("leaves the paying order's own reservation alone until redeem records it", async () => {
      const gift = await issueKind("buyer@example.test", "winback_60_free_ghkcu", "free_product", { slug: "ghk-cu" });
      expect(await reserve(gift, "order-1", "buyer@example.test")).toHaveLength(1);
      // Close BEFORE redeem (defensive ordering): the row this order holds must survive.
      expect(await closeCycle("order-1", "buyer@example.test")).toBe(0);
      expect(await redeem("order-1")).toBe(true);
      const [row] = await rowsFor("buyer@example.test");
      expect(row.redeemed_at).not.toBeNull();
      expect(row.revoked_at).toBeNull();
    });

    it("is idempotent and safe to replay", async () => {
      await issueKind("buyer@example.test", "winback_60_free_shipping", "free_shipping");
      expect(await closeCycle("order-1", "buyer@example.test")).toBe(1);
      expect(await closeCycle("order-1", "buyer@example.test")).toBe(0);
      expect(await closeCycle("order-2", "buyer@example.test")).toBe(0);
    });

    it("does nothing for a missing order id or address", async () => {
      await issueKind("buyer@example.test", "winback_60_free_shipping", "free_shipping");
      expect(await closeCycle("", "buyer@example.test")).toBe(0);
      expect(await closeCycle("order-1", "")).toBe(0);
      const [row] = await rowsFor("buyer@example.test");
      expect(row.revoked_at).toBeNull();
    });

    it("a fresh cycle can be issued after the close, because the index only counts live rows", async () => {
      await issueKind("buyer@example.test", "winback_60_free_shipping", "free_shipping");
      await closeCycle("order-1", "buyer@example.test");
      await expect(issueKind("buyer@example.test", "winback_60_free_shipping", "free_shipping")).resolves.toBeTruthy();
    });

    it("records which automation and send minted a gift, for redemption attribution", async () => {
      await client.query(
        `insert into public.customer_offers (offer_key, token_hash, email, reward_kind, product_slug, min_subtotal_cents, expires_at, automation_key, reference_id)
         values ('winback_60_free_ghkcu', $1, 'buyer@example.test', 'free_product', 'ghk-cu', 6000, now() + interval '30 days', 'winback_60', 'buyer@example.test:1700000000000')`,
        [hash("minted-by")],
      );
      const { rows } = await client.query("select automation_key, reference_id from public.customer_offers where token_hash = $1", [hash("minted-by")]);
      expect(rows[0]).toEqual({ automation_key: "winback_60", reference_id: "buyer@example.test:1700000000000" });
    });

    it("a browser key cannot close anyone's cycle", async () => {
      for (const role of ["anon", "authenticated"]) {
        const { rows } = await client.query(
          "select has_function_privilege($1, 'public.customer_offer_close_cycle(text,text)', 'execute') as can_close",
          [role],
        ).catch(() => ({ rows: [{ can_close: false }] }));
        expect(rows[0].can_close, `${role} can close a cycle`).toBe(false);
      }
    });
  });

  it("a browser key can reach none of it", async () => {
    // The rows carry customer addresses and the shape of who was mailed what,
    // and the functions grant free product. Neither is anon's business.
    for (const role of ["anon", "authenticated"]) {
      const { rows } = await client.query(
        `select has_table_privilege($1, 'public.customer_offers', 'select') as can_read,
                has_function_privilege($1, 'public.customer_offer_reserve(text,text,text,integer)', 'execute') as can_reserve`,
        [role],
      ).catch(() => ({ rows: [{ can_read: false, can_reserve: false }] }));
      expect(rows[0].can_read, `${role} can read customer_offers`).toBe(false);
      expect(rows[0].can_reserve, `${role} can reserve an offer`).toBe(false);
    }
  });
});
