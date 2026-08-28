# Owner decisions — what is left, and what each one needs

Written 2026-08-28 at the end of the Phase 11 pass. Everything above the line
is settled; everything below needs Brenden, and each entry states the exact
question and the facts already gathered so the answer is a short one.

---

## Settled this session — no decision needed

These were reported `NEEDS_OWNER_DECISION` or `BLOCKED` by the phase agents
*only because those agents were forbidden from touching the production
database*. Four read-only queries settled three outright; a fourth turned out
to be a real open hole and was closed.

| Finding | Outcome |
|---|---|
| **F-02** | Production's key is `PRIMARY KEY (order_id, platform)`. The route was right; the repo's DDL was the stale record. Repo corrected, no production change. Guarded in `ads-purchase-event-dedupe.test.ts`. |
| **VL-SQL-04** | The **table** default privilege was open — every new table in `public` started fully writable by `anon`. That is the origin of the 64-of-70 sweep. Closed in production. The **function** half needs no Supabase ticket; see below. |
| **RLS-05** | SELECT revoked from `anon`/`authenticated` on the 36 tables with RLS on and no policies. Behaviour-preserving (such a table already denies every row); guarded in `client-key-table-access.test.ts`. |
| **RLS-11 (item 2)** | Duplicate `ambassadors` SELECT policy dropped after proving it byte-identical to its survivor. |
| **VL-SQL-03 (analytics half)** | `utm_content`, `utm_term`, `ttclid` added to `website_analytics_events`, plus two concurrent partial indexes. The browser and route were already sending these three and the inserter was silently dropping them, so every ad-driven pageview was losing its creative id permanently. |
| **F-A-8** | A failed savings read no longer renders as "you saved nothing" — the account dashboard now shows "—  Couldn't load right now", and the read is paged. |

### Three audit claims that were wrong, now corrected in place

1. **"The `supabase_admin` default privilege is an EXTERNAL DEPENDENCY — needs
   Supabase support."** It is not. A new function reaches `anon` through
   **PUBLIC** in the object ACL (`=X/postgres`; there is no `anon=X` entry at
   all), which is PostgreSQL's own hard-wired default for functions. Proven with
   three probe functions on the harness project. There is no ticket to raise —
   the control is the per-migration `revoke all on function ... from public`
   that `rpc-security-posture.test.ts` already enforces. Corrected in
   `rpc-default-privilege-lockdown.sql`, `DEPLOYMENT-ORDER.md`,
   `FINAL-VERIFICATION-LOG.md`, `INTEGRATION-LOG.md` and
   `LAUNCH-CERTIFICATION.md`.

2. **Three ad-ledger findings in `PHASE1-SYSTEM-MAP.md`** (a P1 and two P2s) all
   rested on the stale single-column PK and on "the upsert happens only in the
   TikTok branch". Both premises are false at HEAD: `recordSend` is called by the
   Reddit leg *and* the TikTok leg, each gated on its own
   `sentPlatforms.has(...)`. Marked RESOLVED/FALSE with the evidence. The one
   half that still stands — `attempts` never increments — is kept.

3. **F5's "the dual `canceled`/`cancelled` spelling is live and deliberate."**
   The census production was asked for shows it is two *different columns*, each
   internally consistent:
   - `payment_status` — one `l` at all four write sites and in all 19 rows
     (`paid` 7, `canceled` 5, `pending_payment` 5, `payment_failed` 2)
   - `fulfillment_status` — two `l`s throughout (`pending` 8, `cancelled` 5,
     `awaiting_fulfillment` 3, `label_purchased` 2, `shipped` 1)

   So `pay === "cancelled"` in `order-status.ts` is a dead branch, not evidence
   of a reconciliation problem. Recorded at that line.

---

## DECIDED AND APPLIED 2026-08-28 — nothing below is waiting on anyone

Brenden's instruction was to stop asking and do what is logical for a store that
lives on these numbers. All five were settled on the merits, applied to
production, and guarded. The original write-ups are kept verbatim below so the
reasoning behind each answer is auditable, with the decision stated at the top
of each.

| # | Decision | Outcome |
|---|---|---|
| 1 | Live sales basis | **`paid_at`.** Revenue is recognised when the money arrives, and it now agrees with /admin/revenue. Applied to the RPC and its TS twin. |
| 2 | Customer "Orders" count | **Exclude warranty replacements.** A reship is the store's own shipment, not an order the customer placed. Applied to both CTEs and the TS twin. |
| 3 | Deploy `ads-system.sql` | **Yes, deployed.** 13 tables, RLS-denied, anon SELECT and INSERT both 0, guardrails in `recommend` mode. |
| 4 | `payment_status` CHECK | **No**, and it stays no. See the reasoning under 4. |
| 5 | `referral-client.ts` fallback | **Leave it.** See the reasoning under 5. |

Decisions 1 and 2 were applied at the only moment they were free, which is why
they were not deferred: production has issued **zero** replacements, and **every
one of its 7 revenue-bearing orders was paid on the day it was created, with no
null `paid_at`**. Both figures were captured before and after and are identical
— `admin_ops_summary` returned `0 | 335.76 | 1 | 1 | 2` either side, and all
four customer rows kept their exact `order_count` and `total_spent`. After the
first order placed near midnight and paid the next morning, that would no longer
have been true.

Migrations: `20260828T0510_live_sales_paid_at_and_customer_order_count.sql`,
`20260828T0515_ads_system_schema.sql`. Guards:
`src/lib/admin-metric-definitions.test.ts` (7 cases, falsified — 4 of them fail
against the reverted code).

---

## The original write-ups, kept for the reasoning

### 1. "Live sales today / this month" on /admin/partners: placed, or paid?

**DECIDED: `paid_at`.** Applied to `admin_ops_summary` and to
`getAdminOperationsSummary`'s fallback. The null-`paid_at` follow-up below turned
out to be moot — production has none.
*(ADM-11 and VL-PARITY-01 are the same question.)*

`admin_revenue_summary` keys revenue on `paid_at`; `admin_ops_summary` keys live
sales on `created_at`. An order created yesterday and paid today counts on
/admin/revenue and not on the /admin/partners tile, and vice versa.

**The question:** does that tile mean orders **placed** in the window, or money
**received** in it?

If you pick `paid_at`, there is a follow-up: legacy rows that are `paid` with a
NULL `paid_at`. Dropping them matches /admin/revenue exactly but removes them
from the tile; `coalesce(paid_at, created_at)` keeps them but the two pages then
disagree on precisely those rows.

Both the RPC and its JS fallback in `partner-portal.ts` move together whichever
way you answer. This is a displayed money figure, which is why nobody guessed.

### 2. /admin/customers "orders" column: every order, or only purchases?

**DECIDED: exclude warranty replacements, keep every status.** A cancelled order
is something the customer did; a reship is something the store did. Applied to
both CTEs of `admin_customer_rollup` and to `aggregateCustomers`. The absent
status filter is preserved on purpose — `total_spent` is the column that filters
on status, and `admin-customers-revenue.test.ts` still pins that split.
*(M-14.)*

`admin_customer_rollup`'s `count(*) as order_count` has no `order_type` filter —
and no status filter either, so it already counts canceled, pending and failed
orders. `admin-customers-revenue.test.ts` records that as a **deliberate**
decision. Excluding only warranty replacements from a count that is otherwise
"every row this email has" is a half-measure somebody should choose on purpose.

**The question:** should that column count every order on the account, or only
purchases? Whichever you pick, the SQL and its JS twin `aggregateCustomers`
change together.

### 3. Deploy `ads-system.sql`? (13 tables, one view, one trigger)

**DECIDED: deployed.** A store that runs paid acquisition needs its ads
dashboard, the schema touches no commerce table (verified by grep — zero
references to orders, products, coupons, referrals or ambassadors), and every
statement is `if not exists`. Applied with the RLS-05 revoke folded in at
creation, so these thirteen never spent a moment in the state that sweep
existed to fix: 14 `ad_` tables, all RLS-enabled, anon SELECT 0, anon INSERT 0,
view `security_invoker = true`, guardrails `mode = 'recommend'` so nothing can
move a budget on its own.
*(VL-SQL-03, remaining half.)*

The time-sensitive part is already done. This is a **feature deployment**, not a
fix: `dashboard-data.ts` degrades cleanly on its absence (42P01) and nothing is
lost by waiting. The view is now created `with (security_invoker = true)`, which
was the one pre-apply fix it needed.

**The question:** deploy the ads dashboard schema now, or after launch?

### 4. A `CHECK` constraint on `orders.payment_status`? — recommend **no**
*(F5. The census it asked for is above; the decision is now a short one.)*

Feasible: 19 rows, 4 distinct values, one spelling. **Not recommended before
launch.** A CHECK that misses a status some code path can write turns a
cancellation into a hard failure in production, and
`setup-local-harness.sh` records that the analogous narrow CHECK on
`referral_orders` (`pc_ro_ps`) did exactly that. The gain is cosmetic; the
downside is a live outage. Revisit post-launch with a full enumeration of every
write site.

### 5. `referral-client.ts`'s legacy fallback — recommend **leave it**
*(RLS-10, and RLS-11 item 1 depends on it.)*

The browser fallback that reads `ambassadors` runs only when the
`validate_referral_code` RPC is **missing** (PGRST202). That RPC exists in
production and is deliberately anon-executable, so the fallback never runs.
Even if it did, RLS returns it zero rows for an anonymous visitor, so it would
return "not active" for every code.

Deleting it means `if (error) throw error`, which changes customer-facing
referral behaviour for zero functional gain, and needs edits in three test files.
The Phase 11 agent judged a half-applied version worse than none and I agree.
**Recommend leaving it, and not revoking `ambassadors` SELECT**, which is the
only thing that fallback's existence is holding open — and which is already
inert behind a `qual false` policy.

---

## Not restated here, deliberately

**F-16-04 update, 2026-08-28.** The repository half of this is now checked and
clean: a scan for `sk_live_`, `rk_live_`, `sk-`, `SG.` and `xox[baprs]-` key
shapes across every `.ts/.tsx/.js/.mjs/.json/.md/.sql/.sh/.yml` file found
exactly two matches, both deliberate fake sentinels inside redaction tests
(`sk_live_sentinelsentinel` in `sentry-privacy.test.ts`, `sk_live_PROCESSOR` in
`admin-audit-log-redaction.test.ts`) — the values those tests use to PROVE
redaction works. No `.env` file is tracked by git except `.env.example`. So no
live key is committed. What that scan cannot see is the Vercel environment
itself; if F-16-04 was about a key held there, it still needs confirming from
the chat that raised it.

The earlier phases recorded further owner items under the ids **VL-25, VL-30,
LF-02, F-16-04** (the Arcline `sk_live_` key), **RLS-08, P2-4** and **INV-06**.
Except for P2-4 (`sql/add-inventory-restock-claim.sql`) none of them is written
down anywhere in this repository — they existed only in the audit conversations.

They are **not** repeated from memory here, because a half-remembered security
finding is worse than a missing one. Retrieve them from the phase chats that
raised them, or re-run that phase's checks. **F-16-04 in particular concerns a
live secret key and should be confirmed rather than assumed handled.**

---

## Production security posture at the end of this session

Queried directly, 2026-08-28. This is the state to re-check after any future
migration.

| Metric | Value |
|---|---|
| Tables in `public` | 70 |
| Tables `anon` can INSERT / UPDATE / DELETE / TRUNCATE | **0** |
| Tables `anon` can SELECT | 27 *(was 63 before RLS-05)* |
| RLS-on tables with zero policies still granting `anon` SELECT | **0** |
| `SECURITY DEFINER` functions `anon` can EXECUTE | **1** — `validate_referral_code`, deliberately client-callable |
| Default privilege for `anon` on **new** tables | `rm` — SELECT and MAINTAIN only; every write letter gone |
| `orders` / `order_items` reachable by `anon` | false |
| `product_doses.product_cost_cents` reachable by `anon` | false |

The last row is the one worth re-reading after any catalogue migration: it is
the true per-variant landed cost, and it was readable by anyone holding the
publishable key until the Phase 1 pass.

### How the RLS-05 revoke was verified against shipped code, not just source

A source scan proves what `main` says; production runs a bundle. So the revoke
was also checked against the built client bundle — all 83 chunks, 2.7 MB, which
includes lazily-loaded ones a page-by-page fetch would miss.

The scan carries its own negative control, because a scan that cannot see
browser Supabase calls would report a clean pass over anything. It looks for
`validate_referral_code`, `"ambassadors"` and `vanta-labs-cart` first — all
three present — and only then reports:

- none of the 36 RLS-05 tables appear as a string literal in the client bundle
- of the five Phase 1 locked tables, only `"orders"` appears, and it is
  pluralisation copy (`e => e === 1 ? "order" : "orders"`), not a table name

An earlier version of this check scanned only the JS referenced by the live
pages' HTML and found no `.from(<table>)` calls at all — which looked like a
pass and was actually a blind scan of the eagerly-loaded chunks only. The
control is what caught it.
