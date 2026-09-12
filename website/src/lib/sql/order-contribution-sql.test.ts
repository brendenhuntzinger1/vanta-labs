import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSuiteDatabase } from "@/lib/e2e/suite-database";

// ---------------------------------------------------------------------------
// M5 — THE CONTRIBUTION SNAPSHOT TABLE, AGAINST A REAL POSTGRES.
//
// The application-level tests mock Supabase, so they prove what the code SENDS.
// They cannot prove what the database ACCEPTS, and four of M5's guarantees live
// entirely in the DDL:
//
//   exactly one snapshot per order        the primary key
//   integer cents, exactly                bigint columns
//   a negative contribution is storable   the absence of a check constraint
//   an unknown attribution stays NULL     nullable columns with no default
//
// A guarantee asserted only in TypeScript is a guarantee one direct SQL insert
// can break. So this applies src/lib/sql/order-contribution.sql verbatim — the
// same file the owner runs — and tests the database it produces.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  process.stderr.write(
    "[order-contribution-sql] SKIPPED — set VANTA_TEST_DATABASE_URL to a throwaway Postgres to run it. "
      + "This is the only proof that the snapshot table enforces one-row-per-order, integer cents, "
      + "and a storable negative contribution.\n",
  );
}

const MIGRATION = readFileSync(path.join(process.cwd(), "src/lib/sql/order-contribution.sql"), "utf8");

/** The one thing the migration's foreign key needs to exist. */
const SCAFFOLD = `
  create table public.orders (
    id bigserial primary key,
    order_id text unique not null,
    order_type text
  );
  insert into public.orders (order_id, order_type) values ('ord-1', null), ('ord-2', null);
`;

/** A complete snapshot row. Every test below perturbs exactly one thing. */
const ROW = {
  order_id: "ord-1",
  formula_version: 1,
  basis: "quote",
  cost_is_estimated: false,
  paid_merchandise_cents: 13998,
  shipping_collected_cents: 1500,
  handling_collected_cents: 0,
  product_cost_cents: 2636,
  gift_cogs_cents: 0,
  processing_fee_cents: 1240,
  shipping_cost_cents: 600,
  store_credit_redeemed_cents: 0,
  points_redeemed_value_cents: 0,
  points_earned_value_cents: 0,
  contribution_before_commission_cents: 11022,
  binding_constraint: "productCost",
};

const COLUMNS = Object.keys(ROW);
const PLACEHOLDERS = COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
const INSERT = `insert into public.order_contribution (${COLUMNS.join(", ")}) values (${PLACEHOLDERS})`;
const valuesFor = (overrides: Record<string, unknown> = {}) =>
  COLUMNS.map((column) => (column in overrides ? overrides[column] : (ROW as Record<string, unknown>)[column]));

describeDb("the contribution snapshot table", () => {
  let client: Client;

  beforeAll(async () => {
    const url = await createSuiteDatabase(DATABASE_URL!, "order_contribution_sql");
    client = new Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  const rebuild = async () => {
    await client.query("drop schema public cascade; create schema public;");
    await client.query(SCAFFOLD);
    // TWICE. A migration that cannot be re-run is one nobody can safely
    // re-apply after a partial failure — and the owner applies these by hand.
    await client.query(MIGRATION);
    await client.query(MIGRATION);
  };

  /** Insert the standard row with an explicit gift_channel, on a fresh table. */
  const insertWithChannel = async (channel: string | null) => {
    await rebuild();
    return client.query(
      `insert into public.order_contribution (${COLUMNS.join(", ")}, gift_channel)`
        + ` values (${PLACEHOLDERS}, $${COLUMNS.length + 1})`,
      [...valuesFor(), channel],
    );
  };

  beforeAll(rebuild);

  it("applies to a fresh database, twice, without error", async () => {
    await rebuild();
    const { rows } = await client.query(
      "select count(*)::int n from information_schema.tables where table_schema='public' and table_name='order_contribution'",
    );
    expect(rows[0].n).toBe(1);
  });

  it("accepts exactly one snapshot per order and refuses a second", async () => {
    await rebuild();
    await client.query(INSERT, valuesFor());

    // A retried checkout must never produce a second row. The primary key is
    // the guarantee; the application's ignoreDuplicates upsert is the courtesy.
    await expect(client.query(INSERT, valuesFor())).rejects.toThrow(/duplicate key|unique/i);

    const { rows } = await client.query("select count(*)::int n from public.order_contribution");
    expect(rows[0].n).toBe(1);
  });

  it("makes an ON CONFLICT DO NOTHING retry a silent no-op that keeps the FIRST row", async () => {
    await rebuild();
    await client.query(INSERT, valuesFor());
    // The shape supabase-js sends for { onConflict: 'order_id', ignoreDuplicates: true }.
    await client.query(`${INSERT} on conflict (order_id) do nothing`, valuesFor({
      contribution_before_commission_cents: 999999,
      paid_merchandise_cents: 999999,
    }));

    const { rows } = await client.query(
      "select count(*)::int n, max(contribution_before_commission_cents)::bigint c from public.order_contribution",
    );
    expect(rows[0].n).toBe(1);
    // The quote-time truth stands; the retry did not overwrite it.
    expect(Number(rows[0].c)).toBe(11022);
  });

  it("stores every financial field as an integer number of cents", async () => {
    await rebuild();
    const { rows: types } = await client.query(
      `select column_name, data_type from information_schema.columns
        where table_schema='public' and table_name='order_contribution' and column_name like '%_cents'
        order by column_name`,
    );
    expect(types.length).toBe(11);
    for (const row of types) {
      expect(row.data_type, `${row.column_name} must be an integer type`).toBe("bigint");
    }

    await client.query(INSERT, valuesFor());
    const { rows } = await client.query("select * from public.order_contribution where order_id='ord-1'");
    for (const [column, value] of Object.entries(rows[0])) {
      if (!column.endsWith("_cents")) continue;
      expect(Number.isInteger(Number(value)), `${column} round-tripped as ${value}`).toBe(true);
    }
    expect(Number(rows[0].paid_merchandise_cents)).toBe(13998);
  });

  it("refuses a fractional cent rather than silently rounding one", async () => {
    await rebuild();
    // A caller that sends dollars where cents are expected must fail loudly.
    await expect(
      client.query(INSERT, valuesFor({ paid_merchandise_cents: 139.98 })),
    ).rejects.toThrow();
  });

  it("stores a NEGATIVE contribution — the signal the table exists to surface", async () => {
    await rebuild();
    // The blueprint's §C2 $50 row: a gift absorbing the only paid unit.
    await client.query(INSERT, valuesFor({
      paid_merchandise_cents: 0, shipping_collected_cents: 0, product_cost_cents: 0,
      gift_cogs_cents: 365, processing_fee_cents: 0, shipping_cost_cents: 793,
      contribution_before_commission_cents: -1158, binding_constraint: "shippingCost",
    }));
    const { rows } = await client.query(
      "select contribution_before_commission_cents c from public.order_contribution where order_id='ord-1'",
    );
    expect(Number(rows[0].c)).toBe(-1158);
  });

  it("leaves every attribution column NULL when nothing supplied one", async () => {
    await rebuild();
    await client.query(INSERT, valuesFor());
    const { rows } = await client.query(
      `select gift_channel, offer_id, offer_key, campaign_key, send_reference_id
         from public.order_contribution where order_id='ord-1'`,
    );
    // No defaults, no empty strings, no "organic" — an order whose attribution
    // is unknown must read as unknown, never as a channel that gets the credit.
    for (const [column, value] of Object.entries(rows[0])) {
      expect(value, `${column} must default to NULL`).toBeNull();
    }
  });

  it("refuses a basis outside the allowed set", async () => {
    await rebuild();
    await expect(client.query(INSERT, valuesFor({ basis: "guess" }))).rejects.toThrow(/check constraint/i);
    // And accepts both real ones.
    for (const basis of ["quote", "settled"]) {
      await rebuild();
      await client.query(INSERT, valuesFor({ basis }));
    }
  });

  it("refuses a gift channel outside the allowed set, and accepts sms, email and NULL", async () => {
    await expect(insertWithChannel("push")).rejects.toThrow(/check constraint/i);
    for (const channel of ["sms", "email", null]) {
      await insertWithChannel(channel);
      const { rows } = await client.query("select gift_channel from public.order_contribution");
      expect(rows[0].gift_channel).toBe(channel);
    }
  });

  it("refuses a snapshot for an order that does not exist", async () => {
    await rebuild();
    await expect(client.query(INSERT, valuesFor({ order_id: "no-such-order" })))
      .rejects.toThrow(/foreign key/i);
  });

  it("drops the snapshot with the order, so no orphan survives a deletion", async () => {
    await rebuild();
    await client.query(INSERT, valuesFor());
    await client.query("delete from public.orders where order_id='ord-1'");
    const { rows } = await client.query("select count(*)::int n from public.order_contribution");
    expect(rows[0].n).toBe(0);
  });

  it("has RLS enabled and no policies — service-role only, like the rest of public", async () => {
    await rebuild();
    const { rows: rls } = await client.query(
      `select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relname='order_contribution'`,
    );
    expect(rls[0].relrowsecurity).toBe(true);
    const { rows: policies } = await client.query(
      "select count(*)::int n from pg_policies where schemaname='public' and tablename='order_contribution'",
    );
    expect(policies[0].n).toBe(0);
  });

  it("carries NO backfill — applying the migration writes no rows", async () => {
    await rebuild();
    // Two orders exist in the scaffold and predate the migration. Neither gets
    // a snapshot: the inputs are not recoverable after the fact, so a backfill
    // would invent them at today's settings. See the file's own docblock.
    const { rows } = await client.query("select count(*)::int n from public.order_contribution");
    expect(rows[0].n).toBe(0);
    expect(MIGRATION).not.toMatch(/insert\s+into\s+public\.order_contribution/i);
  });
});
