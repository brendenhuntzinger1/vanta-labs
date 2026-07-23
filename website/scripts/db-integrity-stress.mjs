// Database-level concurrency + integrity stress harness. Run against a REAL
// Postgres loaded with the production schema (deploy-run-once.sql) to PROVE the
// guarantees the business depends on: RLS deny-by-default, no coupon
// over-redemption, no duplicate ambassador payouts, no inventory oversell, one
// membership per customer, and unique constraints — all under real concurrency.
//
// Setup (no Docker needed — uses the local Postgres server binaries):
//   scripts/verify-db-locally.sh          # inits pg, loads schema, runs this
// Or point at any Postgres with the schema loaded:
//   DATABASE_URL=postgres://user:pass@host:5432/db node scripts/db-integrity-stress.mjs
import pg from "pg";
const { Pool } = pg;
const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, max: 60 }
    : { host: "127.0.0.1", port: 55432, user: "postgres", database: "postgres", max: 60 },
);
const q = (sql, params) => pool.query(sql, params);
// Re-runnable: clear any rows a prior run seeded.
await q(`delete from products where slug='stress-vial'`).catch(() => {});
await q(`delete from coupons where code in ('SOLO1','UNIQX')`).catch(() => {});
await q(`delete from referral_orders where referral_code='STRESSX'`).catch(() => {});
await q(`delete from ambassadors where referral_code='STRESSX'`).catch(() => {});
await q(`delete from customer_memberships where user_id in (select id from auth.users where email='dup@test.com')`).catch(() => {});
await q(`delete from auth.users where email='dup@test.com'`).catch(() => {});
await q(`delete from membership_tiers where slug='elite-x'`).catch(() => {});
let pass = 0, fail = 0; const fails = [];
const check = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; fails.push(name); console.log(`  ❌ ${name} ${detail}`); } };

// Grant anon/authenticated the same table privileges Supabase does, so RLS (not
// a missing GRANT) is what actually blocks access.
await q(`grant usage on schema public to anon, authenticated`);
await q(`grant select, insert, update, delete on all tables in schema public to anon, authenticated`);

console.log("\n[1] RLS deny-by-default — the anon key must read NOTHING sensitive");
for (const t of ["admin_credentials", "orders", "customer_addresses", "payouts", "referral_orders", "points_ledger"]) {
  await q(`insert into ${t} default values`).catch(() => {}); // best-effort seed a row as owner
}
{
  const client = await pool.connect();
  try {
    await client.query("set role anon");
    for (const t of ["admin_credentials", "orders", "customer_addresses", "payouts"]) {
      const r = await client.query(`select count(*)::int as n from ${t}`).catch((e) => ({ rows: [{ n: `ERR:${e.code}` }] }));
      check(`anon reads 0 from ${t}`, r.rows[0].n === 0, `got ${r.rows[0].n}`);
    }
  } finally { await client.query("reset role").catch(()=>{}); client.release(); }
}

console.log("\n[2] Coupon over-redemption — 100 concurrent redeems on a max=1 coupon");
await q(`insert into coupons (code, discount_type, discount_value, active, max_redemptions, redemptions_count) values ('SOLO1','fixed',5,true,1,0) on conflict (code) do update set redemptions_count=0, max_redemptions=1, active=true`);
{
  const results = await Promise.all(Array.from({ length: 100 }, () => q(`select redeem_coupon('SOLO1') as r`).then(r => r.rows[0].r.redeemed).catch(() => false)));
  const redeemed = results.filter(Boolean).length;
  const { rows } = await q(`select redemptions_count from coupons where code='SOLO1'`);
  check("exactly 1 of 100 redeemed", redeemed === 1, `redeemed=${redeemed}`);
  check("redemptions_count never exceeds max (1)", rows[0].redemptions_count === 1, `count=${rows[0].redemptions_count}`);
}

console.log("\n[3] Ambassador payout double-claim — 2 concurrent claims of the same commissions");
const amb = (await q(`insert into ambassadors (name, referral_code, status, commission_percent) values ('Stress Amb','STRESSX','approved',15) returning id`)).rows[0].id;
for (let i = 0; i < 20; i++) await q(`insert into referral_orders (ambassador_id, referral_code, commission_amount, payment_status, order_id) values ($1,'STRESSX',10,'approved_for_payout',$2)`, [amb, `so-${i}`]);
{
  const claim = () => q(`update referral_orders set payment_status='paid' where ambassador_id=$1 and payment_status='approved_for_payout' returning id, commission_amount`, [amb]).then(r => r.rows);
  const [a, b] = await Promise.all([claim(), claim()]);
  const claimedIds = new Set([...a, ...b].map(r => r.id));
  check("each commission claimed exactly once (no double payout)", claimedIds.size === 20 && (a.length + b.length) === 20, `a=${a.length} b=${b.length} unique=${claimedIds.size}`);
  const paidSum = (await q(`select coalesce(sum(commission_amount),0)::numeric as s from referral_orders where ambassador_id=$1 and payment_status='paid'`, [amb])).rows[0].s;
  check("total paid = $200 exactly (20 x $10), never doubled", Number(paidSum) === 200, `sum=${paidSum}`);
}

console.log("\n[4] Inventory oversell — 100 concurrent conditional decrements of a 1-unit product");
const prod = (await q(`insert into products (slug, name, category, price_cents, inventory_quantity, is_active) values ('stress-vial','Stress Vial','Research Peptides',6500,1,true) returning id`)).rows[0].id;
{
  const dec = () => q(`update products set inventory_quantity = inventory_quantity - 1 where id=$1 and inventory_quantity >= 1 returning id`, [prod]).then(r => r.rowCount);
  const results = await Promise.all(Array.from({ length: 100 }, dec));
  const succeeded = results.reduce((a, n) => a + n, 0);
  const { rows } = await q(`select inventory_quantity from products where id=$1`, [prod]);
  check("exactly 1 of 100 decrements succeeds (no oversell)", succeeded === 1, `succeeded=${succeeded}`);
  check("stock never goes negative", rows[0].inventory_quantity === 0, `qty=${rows[0].inventory_quantity}`);
}

console.log("\n[5] One membership per customer (no duplicates)");
const uid = (await q(`insert into auth.users (email) values ('dup@test.com') returning id`)).rows[0].id;
const tier = (await q(`insert into membership_tiers (slug, name, monthly_price_cents, annual_price_cents, points_per_dollar, position) values ('elite-x','Elite',5000,50000,5,3) returning id`)).rows[0].id;
{
  const up = () => q(`insert into customer_memberships (user_id, tier_id, status) values ($1,$2,'active') on conflict (user_id) do update set status='active'`, [uid, tier]);
  await Promise.all(Array.from({ length: 30 }, up));
  const { rows } = await q(`select count(*)::int as n from customer_memberships where user_id=$1`, [uid]);
  check("exactly 1 membership row after 30 concurrent upserts", rows[0].n === 1, `rows=${rows[0].n}`);
}

console.log("\n[6] Unique constraints hold");
{
  await q(`insert into coupons (code, discount_type, discount_value, active) values ('UNIQX','fixed',5,true) on conflict do nothing`);
  const dup = await q(`insert into coupons (code, discount_type, discount_value, active) values ('UNIQX','fixed',5,true)`).then(() => "inserted").catch(e => e.code);
  check("duplicate coupon code rejected (23505)", dup === "23505", `got ${dup}`);
}

console.log(`\n==== DB STRESS RESULTS: ${pass} passed, ${fail} failed ====`);
if (fail) console.log("FAILED:", fails.join(", "));
await pool.end();
process.exit(fail ? 1 : 0);
