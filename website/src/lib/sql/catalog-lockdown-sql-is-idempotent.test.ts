import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSuiteDatabase } from "@/lib/e2e/suite-database";

// ---------------------------------------------------------------------------
// THE TWO LOCKDOWN FILES COULD NOT BOTH BE APPLIED TO A FRESH DATABASE.
//
// gate-catalog-behind-account.sql and revoke-anon-table-access.sql each create
// `products_select_admin` and `product_doses_select_admin`. Whichever ran second
// hit
//
//     ERROR:  policy "products_select_admin" for table "products" already exists
//     ERROR:  current transaction is aborted, commands ignored until end of...
//
// and because each file is ONE transaction, everything in the loser rolled back.
// When the loser was revoke-anon-table-access.sql that meant: the 340-grant
// revoke loop, the ALTER DEFAULT PRIVILEGES change that stops the next migration
// re-granting to the world, and product_images_select_admin. The database came
// up with anon holding every grant it had before — the exact state that file
// exists to end — while psql exited 0, because the errors are per-statement.
//
// Production is not in that state; it was built up over time in an order that
// happened to work. A NEW environment is the exposure: a staging project, a
// disaster-recovery restore, a second store. Reproduced on a throwaway Postgres
// before the fix.
//
// This applies both files in BOTH orders, TWICE each, and then checks the thing
// that actually matters: anon holds nothing.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  process.stderr.write(
    "[catalog-lockdown-sql-is-idempotent] SKIPPED — set VANTA_TEST_DATABASE_URL to a throwaway Postgres to run it. " +
      "This is the only proof that the two catalogue-lockdown files can both be applied to a fresh database.\n",
  );
}

const sql = (name: string) => readFileSync(path.join(process.cwd(), "src/lib/sql", name), "utf8");
const GATE = "gate-catalog-behind-account.sql";
const REVOKE = "revoke-anon-table-access.sql";

/** The minimum a fresh project has before either file runs. */
const SCAFFOLD = `
  create extension if not exists pgcrypto;
  do $$ begin create role anon nologin noinherit; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $$;
  create table public.products (id uuid primary key default gen_random_uuid(),
    is_active bool default true, is_archived bool default false,
    is_enabled bool default true, is_published bool default true);
  create table public.product_doses (id uuid primary key default gen_random_uuid(), product_id uuid);
  create table public.product_images (id uuid primary key default gen_random_uuid(), product_id uuid);
  alter table public.products enable row level security;
  alter table public.product_doses enable row level security;
  alter table public.product_images enable row level security;
  create or replace function public.current_auth_role() returns text language sql stable as $f$ select 'anon'::text $f$;
  -- The world-readable state both files exist to end.
  grant select on public.products, public.product_doses, public.product_images to anon, authenticated;
`;

describeDb("the catalogue lockdown SQL can be applied to a fresh database", () => {
  let client: Client;

  beforeAll(async () => {
    const url = await createSuiteDatabase(DATABASE_URL!, "catalog_lockdown_idempotent");
    client = new Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  const rebuild = async () => {
    await client.query("drop schema public cascade; create schema public;");
    await client.query(SCAFFOLD);
  };

  const anonGrants = async () => {
    const { rows } = await client.query(
      `select count(*)::int n from information_schema.role_table_grants
        where table_schema='public' and grantee in ('anon','authenticated')`,
    );
    return rows[0].n as number;
  };

  const policies = async () => {
    const { rows } = await client.query(
      `select tablename || ':' || policyname as p from pg_policies where schemaname='public' order by 1`,
    );
    return rows.map((r) => r.p as string);
  };

  it.each([
    ["gate then revoke", [GATE, REVOKE]],
    ["revoke then gate", [REVOKE, GATE]],
  ])("applies cleanly in either order — %s", async (_label, order) => {
    await rebuild();
    expect(await anonGrants(), "the scaffold starts world-readable, as production did").toBeGreaterThan(0);

    // Twice, because a migration that cannot be re-run is a migration nobody
    // can safely re-apply after a partial failure.
    for (let pass = 0; pass < 2; pass += 1) {
      for (const file of order as string[]) {
        await client.query(sql(file));
      }
    }

    expect(await anonGrants(), "anon must hold nothing on public after the lockdown").toBe(0);
    expect(await policies()).toEqual([
      "product_doses:product_doses_select_admin",
      "product_images:product_images_select_admin",
      "products:products_select_admin",
    ]);
  });

  it("leaves no policy that would serve the catalogue to a non-admin", async () => {
    await rebuild();
    await client.query(sql(GATE));
    await client.query(sql(REVOKE));
    const { rows } = await client.query(
      `select policyname, pg_get_expr(pol.polqual, pol.polrelid) as using_expr
         from pg_policies p
         join pg_policy pol on pol.polname = p.policyname
         join pg_class c on c.oid = pol.polrelid and c.relname = p.tablename
        where p.schemaname='public'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(String(row.using_expr), `${row.policyname} must require admin`).toContain("'admin'");
    }
  });

  it("stops granting new tables to the world on creation", async () => {
    await rebuild();
    await client.query(sql(GATE));
    await client.query(sql(REVOKE));
    // The half that matters most: without it the NEXT migration re-opens
    // everything, one create table at a time.
    await client.query("create table public.something_new (id int)");
    const { rows } = await client.query(
      `select count(*)::int n from information_schema.role_table_grants
        where table_schema='public' and table_name='something_new' and grantee in ('anon','authenticated')`,
    );
    expect(rows[0].n).toBe(0);
  });
});
