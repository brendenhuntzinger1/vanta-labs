import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSuiteDatabase } from "@/lib/e2e/suite-database";

// ---------------------------------------------------------------------------
// G-02 / G-04 / K-17 — THE RETURN PATH, RUN AS THE SHIPPED SQL.
//
// This executes src/lib/sql/inventory-return-path.sql ITSELF, not a copy of it,
// against a real Postgres. A test that restates the function body would pass
// while the file that actually ships says something else — which is precisely
// how `adjust_inventory_on_sale` came to exist in the repository and not in the
// database.
//
// WHAT IT GUARDS. deploy-run-once.sql:941 defines this function moving
// `inventory_quantity` and nothing else. That is fine on the way down and wrong
// on the way up: finalize_inventory_for_order stamps 'Out of Stock' when a sale
// empties a line, so a refunded unit would come back with the count right and
// the storefront still refusing to sell it. Shipping the repository's copy
// verbatim would have "fixed" refunds into a different silent failure.
//
// The rule applied instead is the repository's own, from the admin receive-stock
// path (inventory-operations.ts:102-108): move the status with the quantity, but
// only the automatic pair — 'Limited' and 'Reserved' are editorial and survive.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  // stderr, not console.warn: vitest swallows console output for a skipped
  // module, which is how fourteen dead proofs once reported success (F-014).
  process.stderr.write(
    "[inventory-return-path] SKIPPED — set VANTA_TEST_DATABASE_URL to a throwaway Postgres to run it.\n",
  );
}

const MIGRATION = readFileSync(path.resolve(__dirname, "sql/inventory-return-path.sql"), "utf8");

/** Just enough of production's shape for the function to act on. */
const SCHEMA = `
create table orders (
  id bigserial primary key,
  order_id text not null unique,
  payment_status text not null default 'paid'
);
create table products (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  inventory_quantity integer not null default 0,
  reserved_quantity integer not null default 0,
  stock_status text not null default 'In Stock',
  track_inventory boolean not null default true,
  updated_at timestamptz not null default now()
);
create table product_doses (
  id uuid primary key default gen_random_uuid(),
  slug text,
  inventory_quantity integer not null default 0,
  reserved_quantity integer not null default 0,
  stock_status text not null default 'In Stock',
  track_inventory boolean not null default true,
  updated_at timestamptz not null default now()
);
`;

describeDb("the inventory return path, as it will actually ship", () => {
  let db: Client;

  beforeAll(async () => {
    const suiteUrl = await createSuiteDatabase(DATABASE_URL!, "inventory-return");
    db = new Client({ connectionString: suiteUrl });
    await db.connect();
    await db.query(SCHEMA);
    // The migration, verbatim. Its grants name roles a throwaway cluster does
    // not have, so those two lines are dropped — nothing else is touched.
    await db.query(
      MIGRATION.split("\n").filter((line) => !/^(revoke|grant)\b/i.test(line.trim())).join("\n"),
    );
  }, 60_000);

  afterAll(async () => { await db?.end(); });

  const qty = async (slug: string) =>
    Number((await db.query("select inventory_quantity from products where slug=$1", [slug])).rows[0].inventory_quantity);
  const status = async (slug: string) =>
    String((await db.query("select stock_status from products where slug=$1", [slug])).rows[0].stock_status);
  const adjust = async (slug: string, delta: number) =>
    Boolean((await db.query("select public.adjust_inventory_on_sale($1, null, $2) as ok", [slug, delta])).rows[0].ok);

  beforeAll(async () => {
    await db.query(`insert into products (slug, inventory_quantity, stock_status) values
      ('sold-out', 0, 'Out of Stock'), ('in-stock', 5, 'In Stock'), ('curated', 0, 'Limited')`);
  });

  it("adds the claim column the restock gate reads", async () => {
    const { rows } = await db.query(
      `select data_type from information_schema.columns
       where table_name='orders' and column_name='inventory_restocked_at'`,
    );
    // Without this, claimInventoryRestock errors 42703 and returns false by its
    // own fail-safe, so nothing is EVER restocked — G-02.
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("timestamp with time zone");
  });

  it("creates the function the return path calls", async () => {
    const { rows } = await db.query(
      `select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='adjust_inventory_on_sale'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("puts a refunded unit back ON SALE, not just back in the count", async () => {
    expect(await adjust("sold-out", 1)).toBe(true);
    expect(await qty("sold-out")).toBe(1);
    // THE POINT. deploy-run-once.sql's version leaves this 'Out of Stock' —
    // the count recovers and the product stays unbuyable.
    expect(await status("sold-out")).toBe("In Stock");
  });

  it("marks a line out of stock when a sale empties it", async () => {
    expect(await adjust("in-stock", -5)).toBe(true);
    expect(await qty("in-stock")).toBe(0);
    expect(await status("in-stock")).toBe("Out of Stock");
  });

  it("leaves an editorial status alone", async () => {
    expect(await adjust("curated", 3)).toBe(true);
    expect(await qty("curated")).toBe(3);
    // 'Limited' is set deliberately in the product editor and must survive a
    // stock movement — the same rule adjustInventoryLine follows.
    expect(await status("curated")).toBe("Limited");
  });

  it("refuses to take a line below zero", async () => {
    expect(await qty("in-stock")).toBe(0);
    expect(await adjust("in-stock", -1)).toBe(false);
    expect(await qty("in-stock")).toBe(0);
  });

  it("reports false for an unknown slug rather than erroring", async () => {
    expect(await adjust("no-such-product", 1)).toBe(false);
  });

  it("is a no-op for a zero or null delta", async () => {
    const before = await qty("curated");
    expect(await adjust("curated", 0)).toBe(false);
    expect(await qty("curated")).toBe(before);
  });

  it("the claim column starts NULL, which reads as 'not yet restocked'", async () => {
    await db.query("insert into orders (order_id) values ('order-return-1')");
    const { rows } = await db.query("select inventory_restocked_at from orders where order_id='order-return-1'");
    expect(rows[0].inventory_restocked_at).toBeNull();
  });

  it("the claim can be won exactly once", async () => {
    const claim = () => db.query(
      `update orders set inventory_restocked_at = now()
       where order_id = 'order-return-1' and inventory_restocked_at is null returning id`,
    );
    expect((await claim()).rowCount).toBe(1);
    // The second refund event, the chargeback, the admin double-click.
    expect((await claim()).rowCount).toBe(0);
  });
});
