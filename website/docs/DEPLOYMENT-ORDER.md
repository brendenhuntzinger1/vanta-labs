# Vanta Labs — Deployment Order

**The operational fact this whole document exists for:**

> `main` is at `9aea901`. **ZERO application code is deployed.**
> **SEVEN migrations are already live in production.**
> The database is AHEAD of the code.

Everything below follows from that. A migration that is already live is not a
step. A migration that is *not* live but whose code *is* about to be, is.

**Steps 1b and 1c have been APPLIED** (2026-08-28, at the owner's request) — see
those steps for the migration versions and the verification. Everything else in
this file is still staged for the owner.

Companion: [`INTEGRATION-LOG.md`](./INTEGRATION-LOG.md) (why each change exists,
with its evidence) · [`FINAL-CERTIFICATION-AUDIT.md`](./FINAL-CERTIFICATION-AUDIT.md).

---

## The one rule that decides the order

Every schema change below is **additive and degradable**: the code checks for the
column or falls back when it is absent, and the migration changes nothing that
exists. That was a deliberate constraint while writing them, and it buys one
thing — **there is no step where the site is broken between two steps.**

Two consequences:

- **Migrations can go first.** Applying them against the currently-deployed code
  (which is `9aea901`, i.e. nothing) is a no-op.
- **Code can go first too.** Every reader degrades. It just does not get the
  benefit until its migration lands.

The order below is the one with the least time spent in a half-state, not the
only order that works. **Where that is NOT true it is called out explicitly, and
there is exactly one such case (Step 4).**

---

## STEP 0 — before anything

| | |
|---|---|
| **Action** | Take a database snapshot / confirm PITR is on. |
| **Verify** | Supabase dashboard → Database → Backups shows a restore point from today. |
| **Rollback** | n/a — this *is* the rollback for everything below. |

**ABORT if:** no restore point exists. Every step below has a written rollback,
but a snapshot is what covers the step nobody predicted.

---

## STEP 1 — `referral_orders` commission lifecycle  ⚠️ **LAUNCH BLOCKER**

| | |
|---|---|
| **Apply** | `website/src/lib/sql/referral-orders-commission-lifecycle.sql` |
| **Why** | Production's CHECK admits only `paid\|refunded\|partially_refunded`. The application's commission lifecycle is `pending → approved_for_payout → paid`. **Every accrual is refused, so the first real ambassador sale loses its commission silently.** (M-01) |
| **Rollback** | `ROLLBACK-referral-orders-commission-lifecycle.sql` |
| **Blast radius** | Widening a CHECK cannot invalidate an existing row, and `referral_orders` has **0 rows**. |

**Verify:**
```sql
select pg_get_constraintdef(oid) from pg_constraint
where conname = 'referral_orders_payment_status_check';
-- expect: pending, approved_for_payout, paid, reversed, voided, refunded, partially_refunded
select column_default from information_schema.columns
where table_name='referral_orders' and column_name='payment_status';   -- expect 'pending'::text
```

**Rollback caveat, by design:** the rollback **fails** if any row holds a value
outside the original three. That is correct — reverting would orphan real accrued
commissions, and what happens to those is the owner's decision, not a migration's.

> ### Order note — REWRITTEN AFTER REVIEW FINDING 1. Read this one.
>
> Step 1 must land **before or with** the code, not after.
>
> **The previous wording here was wrong, and wrong in the direction that gets
> data destroyed.** It said the code half was "harmless without it — the insert
> simply keeps failing exactly as it does today — so there is no broken
> half-state either way." That was false. Deploying the code before this
> migration did not merely leave commissions un-accrued; it **destroyed them
> permanently, one per referred order, with no way to reconstruct them.**
>
> Why: both paid lanes take a single-use, exactly-once claim and THEN accrue.
> The card lane flips `orders.paid_side_effects_at` NULL→now; the manual lane
> flips `payment_status` under a read-guard. Once that claim lands the accrual
> gets exactly ONE attempt. A webhook redelivery loses the claim. An admin's
> second approve returns `alreadyPaid`. So each 23514 burned an order's only
> chance at its commission and left a `console.error` in a serverless log as the
> sole record of money owed to a real person.
>
> **This is now recoverable, and that is a safety net, not a licence.**
> `repairMissingCommissionAccruals()` (registered in the cron sweep) re-derives
> any missing accrual from the order row — `orders` already carries
> `ambassador_id`, `referral_code`, `subtotal` and `discount_amount`, which is
> everything the accrual consumes. It clears the existing backlog on its next run
> after this migration is applied, and it raises a critical alert for anything it
> still cannot fix.
>
> So the honest statement of the risk is now: **deploying out of order costs
> every referred order's commission until the migration lands and the sweep next
> runs, plus one alert.** It is no longer unrecoverable. Apply the migration
> first anyway — the sweep exists because deployments go wrong, not so that this
> one can.

---

## STEP 1b — `manual_review` commission status  ⚠️ **LAUNCH BLOCKER**

| | |
|---|---|
| **Apply** | `website/src/lib/sql/referral-orders-manual-review-status.sql` |
| **Why** | Step 1 widened the commission lifecycle but left out `manual_review`, and that is the value the REFUND path writes: a refund of an order whose commission was already paid out cannot claw the money back, so it is flagged for an admin instead. The write is refused with `23514`. Because it happens *inside* the webhook's refund branch, the exception used to abort the whole refund — no commission reversal, **no restock**, no points or store-credit return — and the processor's retry was short-circuited by the already-terminal guard, so the work was lost rather than deferred. (VL-7 / P12-01, and the trigger for REF-02) |
| **Rollback** | `ROLLBACK-referral-orders-manual-review-status.sql` |
| **Blast radius** | Widening a CHECK cannot invalidate an existing row. Drops by RULE, so it also removes the harness's `pc_ro_ps` duplicate. |
| **APPLIED** | ✅ 2026-08-28 as migration `20260828002848_referral_orders_manual_review_status`. Pre-flight found `referral_orders` at **0 rows** and a single constraint carrying Step 1's list without `manual_review` — no `pc_ro_ps` duplicate in production, as documented. Verified after: the constraint admits all eight lifecycle values including `manual_review`, exactly one payment_status CHECK remains, and the default is still `'pending'`. |

**Verify:**
```sql
select pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'public.referral_orders'::regclass and contype = 'c'
  and pg_get_constraintdef(oid) like '%payment_status%';
-- expect ONE row, including 'manual_review'
```

**Apply with or before Step 1** — the file is standalone and supersedes Step 1's
constraint list. The code fix that stops a `23514` here taking the rest of the
refund down with it (REF-02) is independent and ships in Step 7; both are needed.

---

## STEP 1c — refund exactly-once indexes

| | |
|---|---|
| **Apply** | `website/src/lib/sql/refund-exactly-once-indexes.sql` |
| **Why** | The three refund effects that hand money back — points reversal, points restore, store-credit return — enforce "once per order" with a SELECT immediately before the INSERT. There are **two writers by design** (the refund webhook and the half-hourly repair sweep, which selects on exactly the absence those guards read), so both can pass the check and both insert: the customer is credited twice and neither caller reports anything wrong. (REF-03 / F3) |
| **Rollback** | `ROLLBACK-refund-exactly-once-indexes.sql` |
| **Blast radius** | Two partial unique indexes over refund rows only; ordinary grants, earns and redemptions are untouched. The file REFUSES to run if duplicates already exist — those are money already handed out, and a migration must not pick which copy to delete. |
| **APPLIED** | ✅ 2026-08-28 as migration `20260828002900_refund_exactly_once_indexes`. Pre-flight found **0** refund rows in either ledger (17 points_ledger rows, 3 store_credit_ledger rows overall), so the duplicate guard had nothing to refuse. Both indexes verified present with the expected partial predicates. |

**Verify:**
```sql
select indexname from pg_indexes where schemaname='public'
  and indexname in ('idx_points_ledger_order_refund_once',
                    'idx_store_credit_ledger_order_refund_once');  -- expect 2 rows
```

**Code-first is fine, and slightly preferable.** `refundStoreCreditForOrder` now
writes ONE aggregated refund row per account per order instead of one per
redemption row, which is the shape the store-credit index requires; deploying
the code first means an order refunded in the gap already has that shape.

## STEP 2 — the inventory return path  ⚠️ **LAUNCH BLOCKER**

| | |
|---|---|
| **Apply** | `website/src/lib/sql/inventory-return-path.sql` |
| **Why** | `orders.inventory_restocked_at` and `adjust_inventory_on_sale` are both absent. The restock claim errors `42703`, so **nothing is ever restocked** — every refund and cancellation permanently destroys its units while tracking is ON. (G-02, G-04/I-12, K-17) |
| **Also fixed in code (finding 2)** | That failure used to be **indistinguishable from success**. `claimInventoryRestock` returned a bare `false` for both "somebody else already restocked this" and "the claim could not be evaluated", so the cancel path reported the missing column to the operator as `already_returned`. It now returns `claimed` / `already_claimed` / `unavailable`, and `unavailable` raises a critical alert instead of a reassuring string. **Until this migration lands, every cancel and refund now ALERTS rather than silently writing off stock.** |
| **Rollback** | `ROLLBACK-inventory-return-path.sql` |
| **Blast radius** | One nullable column, one partial index, one new function. No existing row changes. |

**Verify:**
```sql
select 1 from information_schema.columns
where table_name='orders' and column_name='inventory_restocked_at';        -- 1 row
select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='adjust_inventory_on_sale';         -- 1 row
select has_function_privilege('anon','public.adjust_inventory_on_sale(text,text,integer)','EXECUTE');
-- expect FALSE
```

**Why this is safe to apply even though a replay could double-decrement:** it
cannot. `paid_side_effects_at` is the exactly-once claim and it **is already
live** — a replayed webhook never reaches the inventory block. The missing
function is currently a *second* line of defence; restoring it behind a first
line that is verified present is the correct order, and only that order.

**Rollback caveat:** if `inventory_restocked_at` is non-zero anywhere, dropping
the column loses the record that those units were already returned, and a later
re-apply could return them twice. Prefer reverting only the function.

---

## STEP 3 — `pending_emails` order link

| | |
|---|---|
| **Apply** | `website/src/lib/sql/pending-emails-order-link.sql` |
| **Why** | The retry sweep delivers a receipt and cannot close the send-once slot, so the next caller sends the customer a **second** receipt. (C-02) |
| **Rollback** | `ROLLBACK-pending-emails-order-link.sql` |
| **Blast radius** | Two nullable columns + one partial index on a table with **zero rows ever**. |

**Verify:**
```sql
select column_name, data_type from information_schema.columns
where table_name='pending_emails' and column_name in ('order_id','email_kind');
-- expect BOTH, and order_id must be TEXT (it joins order_email_log.order_id, which is text)
```

**Either order with the code.** `enqueueFailedEmail` falls back to the old insert
when the columns are absent, and the sweep falls back to the old select. Losing a
customer's receipt because a column was not there yet would be a far worse trade
than losing the write-back.

---

## STEP 4 — referral code management  ⚠️ **THE ONE ORDER-SENSITIVE STEP**

| | |
|---|---|
| **Apply** | `website/src/lib/sql/referral-code-management.sql` |
| **Why** | 2 tables and 2 columns on each of `ambassadors`/`partners` that the repo declares and production has none of. **The whole ambassador "change my code" feature is inert** — an approved ambassador is told *"Only approved ambassadors can set a referral code."* (M-03) |
| **Rollback** | see below |
| **Blast radius** | Entirely additive; every statement is `if not exists`. |

**This is the exception to "either order".** The customer-facing referral **link**
works today because `resolveReferralCode` checks the live `ambassadors`/`partners`
rows first and returns before touching the alias table. That will keep working
whatever you do here.

**Apply this migration BEFORE deploying code that lets an ambassador change their
code.** Without it a code change fails closed (annoying); with the code but
without the tables, an ambassador could change a code while the **alias that
redirects their old links is never written** — every link already printed or
posted stops attributing, silently, and there is no record of the change.

**Verify:**
```sql
select to_regclass('public.referral_code_aliases'), to_regclass('public.referral_code_changes');
select column_name from information_schema.columns
where table_name='ambassadors' and column_name in ('referral_code_locked','referral_code_changed_at');
-- expect both tables and both columns
```

**Rollback:**
```sql
drop table if exists public.referral_code_aliases;
drop table if exists public.referral_code_changes;
alter table public.ambassadors drop column if exists referral_code_locked,
                               drop column if exists referral_code_changed_at;
alter table public.partners    drop column if exists referral_code_locked,
                               drop column if exists referral_code_changed_at;
```
Safe only while no alias row exists; an alias row is a live redirect for an
ambassador's old links, and dropping it breaks those links.

---

## STEP 5 — RPC default-privilege lockdown (security hardening)

| | |
|---|---|
| **Apply** | `website/src/lib/sql/rpc-default-privilege-lockdown.sql` |
| **Why** | Supabase grants EXECUTE on every new `public` function to `anon`. That is what made `create_partner_invite` an unauthenticated write into the affiliate money tables. (I-07 → I-11) |
| **Rollback** | `ROLLBACK-rpc-default-privilege-lockdown.sql` (re-arms it — there is no good reason to run it) |
| **Blast radius** | **None to existing objects.** `ALTER DEFAULT PRIVILEGES` changes only what happens at CREATE time. |

**Apply AFTER Steps 1–4**, so the functions those steps create are already in
place and can be verified individually.

**This does not fully close it, and the verification will show that.**
There are two grantors and only the `postgres` half is reachable from this
project's access — measured on the harness, not assumed. The `supabase_admin`
half needs Supabase support and is listed under EXTERNAL DEPENDENCIES.

> **CORRECTED 2026-08-28 (VL-SQL-04):** there is no Supabase support ticket here. A function created after the ALTER stays anon-executable via **PUBLIC** in the object ACL (`=X/postgres` — no `anon=X` entry exists), which is PostgreSQL's own hard-wired default for functions, not a `supabase_admin` grant. Proven with three probe functions on the harness. The remedy is the per-migration `revoke all on function ... from public` already enforced by `rpc-security-posture.test.ts`. Separately, the **table** half of the same default WAS a real open hole — every new table started fully writable by `anon`, which is where the 64-of-70 sweep came from — and it is now closed in production (`migrations-applied/20260828T0240_default_privilege_table_write_lockdown.sql`).

**Verify:**
```sql
select exists (select 1 from pg_default_acl d join pg_namespace n on n.oid=d.defaclnamespace
  where n.nspname='public' and d.defaclobjtype='f'
    and d.defaclacl::text ~ '(anon|authenticated)=X') as still_armed;
-- expect TRUE, and that is the known-and-recorded outcome, not a failure

select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.prosecdef
  and (has_function_privilege('anon', p.oid,'EXECUTE')
    or has_function_privilege('authenticated', p.oid,'EXECUTE'));
-- expect EXACTLY ONE row: validate_referral_code
```

**ABORT if** that second query returns anything other than `validate_referral_code`.

---

## STEP 5b — drop the duplicate rate-limit index (RUN THIS BEFORE THE DEPLOY)

**Reclassified from OPTIONAL by review finding 6.** The reviewer's point stands:
this block is what made "every insert" mean every checkout, referral click and
login attempt, and shipping that against a table carrying two byte-identical
indexes is paying the new cost twice on the hottest write path in the app. The
denied-bucket memo added under finding 6 bounds the amplification for buckets
already over their limit, but every ALLOWED request still writes — so the
duplicate index is still paid on all legitimate traffic.

It remains fully reversible and zero-blast-radius; what changed is the ordering,
not the risk.

| | |
|---|---|
| **Apply** | the `drop index` below, BEFORE deploying this block |
| **Why** | `rate_limit_hits` carries **two byte-identical indexes** on `(bucket, created_at DESC)`. Every insert maintains both. This block's rate-limiter rewrite made that table take **one insert per throttled request** — the hottest write path in the app — so the redundant one is paid for on every checkout, referral click and login attempt. |
| **Rollback** | recreate it (below). Fully reversible. |
| **Blast radius** | None. The remaining index has the identical definition, so no query plan loses its access path. |

**Measured on production, not assumed** — the planner has already chosen
between them:

| index | size | `idx_scan` |
|---|---|---|
| `rate_limit_hits_bucket_time_idx` | 280 kB | **20,606** |
| `idx_rate_limit_bucket_time` | 272 kB | **49** |

Same definition, 400× the usage. The low-scan one is duplicated work.

**Apply:**
```sql
drop index concurrently if exists public.idx_rate_limit_bucket_time;
```
`concurrently` so it never takes a lock that could block a checkout. It cannot
run inside a transaction block — run it on its own.

**Rollback:**
```sql
create index concurrently if not exists idx_rate_limit_bucket_time
  on public.rate_limit_hits using btree (bucket, created_at desc);
```

**Verify:**
```sql
select count(*) from pg_index i
join pg_class t on t.oid = i.indrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public' and t.relname = 'rate_limit_hits'
  and pg_get_indexdef(i.indexrelid) like '%(bucket, created_at DESC)%';
-- expect 1
```

**ABORT if** that returns 0 — the surviving index was dropped instead. Recreate
it with the rollback above immediately; the limiter's count query degrades to a
sequential scan without it (it fails open, so the store keeps serving, but
every throttled route is unlimited until it is back).

**Skipping this is safe.** It costs a little write throughput and some storage,
nothing correctness-related.

---

## STEP 6 — configuration, before the code

Set in Vercel **Production** before deploying. See INTEGRATION-LOG §7 for the
full expected-vs-actual comparison.

| Variable | Why it must be right before the deploy |
|---|---|
| `CRON_SECRET` | present, or `/api/cron/sweep` 401s and **thirteen jobs never run** |
| `RESEND_API_KEY` | **rotate** — it sat in `admin_audit_logs` in plaintext (I-01) |
| `SHIPPO_API_TOKEN` | same |
| `VEYRA_API_KEY` / `VEYRA_API_BASE` | same; and a missing base is what G-03 reproduced |
| `TIKTOK_EVENTS_API_ACCESS_TOKEN`, `REDDIT_CONVERSIONS_ACCESS_TOKEN` | **must be scoped per environment** — otherwise a preview reports into live ad accounts (K-16). The code gate now refuses non-production, but the token is the belt to that braces |
| `SHIPPO_ALLOW_LABEL_PURCHASE` | leave **unset/false** until a real label is intended |

**ABORT if** the four credentials in I-01 have not been rotated. They were
readable in plaintext by any manager-or-above session and must be treated as
compromised.

---

## STEP 7 — deploy the application code

First application deploy ever. `main` is at `9aea901`; this branch is what ships.

**Rollback:** Vercel → Deployments → promote `9aea901`. Instant, and safe,
because every migration above is additive and the old code neither reads nor
writes any of the new columns.

---

# POST-DEPLOY SMOKE TEST — 5–10 minutes

Run **in this order**. Each line is one check with one expected answer.

| # | Check | Expect |
|---|---|---|
| 1 | `GET /api/health` | 200 |
| 2 | Homepage loads | 200, age gate appears, no console error |
| 3 | Catalog `/products` | products render; **31 of 36 show In Stock** (F-001) |
| 4 | One PDP | price, dose selector, stock badge |
| 5 | Add to cart → cart | line, subtotal, shipping, protection **unticked** (K-25) |
| 6 | Apply a referral code | discount line appears; try `HOLDPROBE` → *"not active"* |
| 7 | Begin checkout, **stop before paying** | totals render; no order written until Continue |
| 8 | `/admin` login | loads; orders, inventory, fulfilment queue all render |
| 9 | Admin → Email settings | provider shows configured; **no secret value rendered** (I-01) |
| 10 | `select count(*) from pending_emails where status='failed'` | 0 |
| 11 | Trigger `/api/cron/sweep` with `CRON_SECRET` | 200, and `system_alerts` gains no `critical` row |
| 12 | `select * from system_alerts where severity='critical' and created_at > now() - interval '1 hour'` | **0 rows** |

## ABORT / ROLLBACK CONDITIONS — objective

Roll back **immediately** (Vercel promote `9aea901`) if any of these is true:

1. Any check 1–8 fails.
2. `system_alerts` gains a `critical` row of type `rate_limit_degraded`,
   `inventory_rpc_failed`, or `cron_sweep_failed` within the first hour.
3. `select count(*) from orders where payment_status='paid' and paid_side_effects_at is null`
   is **greater than 0** — a paid order whose side effects never ran.
4. Any order is written with `payment_status='paid'` and `amount_paid = 0` that is
   not `order_type='replacement'`.
5. A second receipt reaches any customer (`order_email_log` shows two `sent` rows
   for one `(order_id, kind)`).
6. `select count(*) from products where inventory_quantity < 0` is greater than 0.

**Rolling back the CODE does not roll back the MIGRATIONS, and does not need to.**
Every one is additive and `9aea901` ignores all of them.

---

# WHAT IS NOT IN THIS SEQUENCE

| Item | Why not |
|---|---|
| Historical refund restock | Orders refunded before Step 2 already lost their units. Replaying that is a data decision — which orders, and does the physical shelf agree — not a migration. Query in `inventory-return-path.sql`. |
| `email_suppressions` backfill | Nothing to backfill; the table is correct. |
| The `supabase_admin` default privilege | ~~**EXTERNAL DEPENDENCY** — needs Supabase support.~~ **NOT AN EXTERNAL DEPENDENCY (corrected 2026-08-28).** The residual function exposure is PUBLIC in the object ACL, not a `supabase_admin` grant; the control is the per-migration `revoke ... from public`. The table half is closed in production. |
| COA documents | **EXTERNAL DEPENDENCY** — the store advertises COA documentation and `coa_records` is empty (F-006). |
