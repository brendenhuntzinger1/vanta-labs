import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createSuiteDatabase } from "@/lib/e2e/suite-database";

// ---------------------------------------------------------------------------
// "Notify me when it's back" never enrolled anyone, and said so to the customer.
//
// requestBackInStock upserts with
//   { onConflict: "product_slug,variant_id,email", ignoreDuplicates: true }
// but the only unique index on back_in_stock_requests, in production AND in the
// harness, is
//   CREATE UNIQUE INDEX idx_bis_unique_pending
//     ON back_in_stock_requests (product_slug, COALESCE(variant_id, ''), email)
//     WHERE notified = false;
//
// A PARTIAL index over an EXPRESSION. `ON CONFLICT (product_slug, variant_id,
// email)` matches neither the expression nor the predicate, so Postgres raises
// 42P10 and writes nothing. PostgREST's onConflict takes a bare column list and
// cannot express either half, so no value of that option can ever target this
// index — the upsert form itself is the defect, not its arguments.
//
// The caller then reads the failure:
//   if (error && !error.message.includes("duplicate")) return { ok: false, ... }
// 42P10's message is "there is no unique or exclusion constraint matching the
// ON CONFLICT specification". No "duplicate" in it, so every enrolment returned
// "Unable to save your request right now." Production agrees: the table holds
// zero rows.
//
// Executed against a real Postgres carrying the real index, because no
// in-memory double models conflict-target resolution — which is exactly why
// 4,842 passing tests never saw this.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  process.stderr.write(
    "[back-in-stock-enrolment] SKIPPED — set VANTA_TEST_DATABASE_URL to a throwaway Postgres to run it.\n",
  );
}

/** The shipped shape, index included, copied from production's pg_indexes. */
const SCHEMA = `
create table back_in_stock_requests (
  id uuid primary key default gen_random_uuid(),
  product_slug text not null,
  variant_id text,
  email text not null,
  notified boolean not null default false,
  notified_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index idx_bis_unique_pending
  on back_in_stock_requests (product_slug, coalesce(variant_id, ''), email)
  where notified = false;
`;

let client: Client;

beforeAll(async () => {
  if (!DATABASE_URL) return;
  const url = await createSuiteDatabase(DATABASE_URL, "back_in_stock_enrolment");
  client = new Client({ connectionString: url });
  await client.connect();
  await client.query("create extension if not exists pgcrypto");
  await client.query(SCHEMA);
});

afterAll(async () => {
  if (client) await client.end();
});

describeDb("enrolling in a back-in-stock notification", () => {
  it("cannot be written with the conflict target the code declares", async () => {
    // Documents WHY the upsert form has to go: this is the exact statement
    // supabase-js issues, and Postgres refuses it outright.
    await expect(
      client.query(
        `insert into back_in_stock_requests (product_slug, variant_id, email)
         values ('glp-1', null, 'buyer@example.com')
         on conflict (product_slug, variant_id, email) do nothing`,
      ),
    ).rejects.toThrow(/no unique or exclusion constraint matching the ON CONFLICT/i);
  });

  it("records a pending request, so a restock has someone to email", async () => {
    await client.query("delete from back_in_stock_requests");
    await client.query(
      `insert into back_in_stock_requests (product_slug, variant_id, email)
       values ('glp-1', null, 'buyer@example.com')
       on conflict (product_slug, coalesce(variant_id, ''), email) where notified = false do nothing`,
    );
    const { rows } = await client.query("select email from back_in_stock_requests where notified = false");
    expect(rows.map((r) => r.email)).toEqual(["buyer@example.com"]);
  });

  it("keeps one pending row when the same person asks twice", async () => {
    await client.query("delete from back_in_stock_requests");
    const enrol = () =>
      client.query(
        `insert into back_in_stock_requests (product_slug, variant_id, email)
         values ('glp-1', null, 'buyer@example.com')
         on conflict (product_slug, coalesce(variant_id, ''), email) where notified = false do nothing`,
      );
    await enrol();
    await enrol();
    const { rows } = await client.query("select count(*)::int n from back_in_stock_requests");
    expect(rows[0].n).toBe(1);
  });

  it("lets someone re-enrol after they were notified", async () => {
    // The index is partial ON PURPOSE: a notified row must not block the next
    // restock's request, or a customer gets exactly one notification ever.
    await client.query("delete from back_in_stock_requests");
    await client.query(
      `insert into back_in_stock_requests (product_slug, variant_id, email, notified, notified_at)
       values ('glp-1', null, 'buyer@example.com', true, now())`,
    );
    await client.query(
      `insert into back_in_stock_requests (product_slug, variant_id, email)
       values ('glp-1', null, 'buyer@example.com')
       on conflict (product_slug, coalesce(variant_id, ''), email) where notified = false do nothing`,
    );
    const { rows } = await client.query(
      "select count(*)::int n from back_in_stock_requests where notified = false",
    );
    expect(rows[0].n).toBe(1);
  });
});
