# VANTA LABS — COMPLETE FIX REGISTER

Every fix, across every block and every session of the production-certification
audit, grouped by subsystem. Written by an independent verification session that
read the code and queried production rather than trusting the prior write-ups.

**Read this first, because it governs every row below.**

> **ZERO application code from this audit is running in production.**
> Three *database* remediations are live (F-009, F-013, I-07). Everything else
> is on the integration branch and has never served a customer.

## The four STATUS values, which are not interchangeable

| status | meaning |
|---|---|
| **CODE ONLY** | Fixed on the branch. Not deployed. Not exercised against production. |
| **MIGRATION STAGED** | A `.sql` file exists and has **not** been applied. The code that needs it will misbehave until it is. |
| **LIVE IN PRODUCTION** | Actually applied to the production database and verified there. |
| **VERIFIED** | Independently re-proved in *this* session, by command, query, or mutation control. |

A row can carry more than one. "A test exists" is never, on its own, a fix.

## Arithmetic — recounted, not copied

`INTEGRATION-LOG.md` asserts 131 numbered + 2 sub + 16 unnumbered = 149 tracked
items. Independently recounted from the source documents in this session:

| block | ids | count |
|---|---|---|
| A+B / Phases 0–2 | `F-001…F-019` | 19 |
| C | `C-01…C-16` | 16 |
| D | `D-01…D-07` | 7 |
| E-A | `E-A-01…E-A-02` | 2 |
| E-B | `E-B-01…E-B-08` | 8 |
| F-A | `F-A-01…F-A-21` | 21 |
| F-B | `F-B-01…F-B-05` | 5 |
| G+H | `G-01…G-05`, `H-01` | 6 |
| I | `I-01…I-12` | 12 |
| J | `J-01…J-09` | 9 |
| K | `K-01…K-23`, `K-25…K-27` (`K-24` never issued) | 26 |
| | **sum** | **131** ✔ |

Plus sub-findings `I-03b`, `I-05b` (2) and 16 unnumbered Block K sweep items =
**149**. **The published arithmetic is correct.** Added since: `M-01`, `M-02`
(Block M) and `N-01…N-07` (Block N) = **158 tracked items**.

Nothing is missing from this register. Where a finding was filed but not fixed
it appears under **STILL OPEN**; where it was filed and turned out not to be a
defect it appears under **DISPROVED**.

---

# THE REGISTER

Severity and original id are as filed by the owning block. BEFORE/AFTER/IMPACT
are written for a non-engineer.

## Ambassador & referral · Commissions / payouts

| id | sev | BEFORE | AFTER | IMPACT | EVIDENCE | FILES | STATUS |
|---|---|---|---|---|---|---|---|
| **G-01 / M-01** | **P0** | Every ambassador commission failed to save. The database only accepted three words for a commission's state and the code wrote a fourth (`pending`), so the write was rejected every single time. The error was caught and logged; the shop reported success. | The constraint is widened to the real lifecycle, dropped **by rule not by name** so a duplicate under another name cannot survive the migration. | The first real ambassador sale would have silently paid nobody. No ambassador would ever have been paid, and nothing on any screen would have said so. | Reproduced against production with a rolled-back `DO` block. **Re-verified this session:** production's CHECK is still `('paid','refunded','partially_refunded')` — `pending` is still refused today. | `sql/referral-orders-commission-lifecycle.sql` | **MIGRATION STAGED — NOT APPLIED. DEPLOY BLOCKER.** |
| **N-01** | **P0** | If a commission failed to save even once, it was gone forever. The "this order is done" flag was set *before* the commission was written, so no retry ever re-ran it. On the manual-approval lane the failure also killed everything after it — coupon redemption, loyalty points, the confirmation email, membership activation, **and the stock decrement**. The customer paid, the shelf never moved, and the store kept selling units it no longer had. | The accrual is best-effort and caught. A scheduled sweep re-derives any missing commission straight from the order row, oldest first, and raises a critical alert if it still cannot. Everything below the accrual now always runs. | Permanently lost money owed to a real person, plus oversold stock on every manual approval that hit the error. | Read adversarially this session: cannot double-pay (`referral_orders_order_id_key UNIQUE(order_id)` verified in production; rows are never deleted anywhere in the repo), cannot accrue for a refunded order, and reproduces the live formula exactly — all three lanes compute `subtotal − discount_amount` and share one writer. **Mutation controls M4, M5 — both caught.** | `lib/commission-accrual-repair.ts` (new), `lib/payment-webhook.ts`, `api/cron/sweep/route.ts` | **CODE ONLY · VERIFIED** |
| **N-04** | **P1** | Five screens each decided "what counts as revenue" their own way — three different rules. The one function written to be the single source of truth had **zero callers**. | All five surfaces import `ledger.isRevenueOrderStatus`. The hand-written duplicate in the profit report is deleted. | The dashboard, the revenue page, the email stats, memberships and best-sellers could each report a different total for the same day. | Verified this session: 5 real call sites, duplicate gone. **Mutation M7 — caught.** | `lib/ledger.ts`, `admin-analytics.ts`, `admin-email.ts`, `admin-profit.ts`, `admin-membership.ts`, `best-sellers.ts` | **CODE ONLY · VERIFIED** |
| **F-009** | **P0** | An ambassador added by hand could never complete a signup — the application would always fail. | Partner creation is one atomic database function, idempotent per user. | BRUTUS was approved for four weeks with a dead referral link and nobody knew. | Atomicity proven against production with a rolled-back probe. **Re-verified:** `create_partner_application` exists in production. | `partner-portal.ts`, `sql/partner-identity-convergence.sql` | **LIVE IN PRODUCTION** |
| **F-013** | **P0** | The admin invite door reopened the same defect F-009 had just closed. | Invite path converged onto the same atomic identity rule. | Would have silently undone the F-009 repair. | Applied and verified in production. | `partner-portal.ts`, `sql/partner-invite-convergence.sql` | **LIVE IN PRODUCTION** |
| **F-016** | **P0** | The commission sweep overwrote money that had moved while it was deciding. | Read/write race closed. | Could pay or un-pay a commission that had already been settled. | `affiliate-concurrency.test.ts` — **9 tests, run against a real Postgres for the first time in this session, all pass.** | `partner-portal.ts` | **CODE ONLY · VERIFIED** |
| **F-017 / C-01** | **P0** | The approval email quoted a commission rate the ambassador does not actually earn — read from the wrong table. | One authoritative table for the rate. | An ambassador is told 20% in writing and paid 15%. Written promise, legal exposure. | 4 red tests written first, then closed; C-01 confirmed closed at merge. | `partner-portal.ts` | **CODE ONLY** |
| **F-018** | **P0** | Approving an ambassador with no mirror row reported success and did nothing. | Fails loudly. | Approved partners with dead links. | Block A+B | `partner-portal.ts` | **CODE ONLY** |
| **F-019** | **P0** | Commission accrual and payout release were gated by two different tables that could disagree. | One gate. | Could pay a commission that was never earned, or withhold one that was. | Block A+B | `partner-portal.ts` | **CODE ONLY** |
| **E-B-02** | **P0** | The rate an ambassador is paid had no behavioural test at all. | 19 tests. | Any future edit could change what people are paid, undetected. | 19 tests | test suite | **CODE ONLY** |
| **E-B-03** | **P0** | Nobody could send an ambassador money wrongly and be noticed. | 13 tests. | Undetectable payout errors. | 13 tests | test suite | **CODE ONLY** |
| **F-002 / F-003** | info | Recorded facts about the partner tables and the discount sentinel. | — | — | Recorded, not defects. | — | **RECORDED** |

## Inventory & reservations · Cancellation & restock

| id | sev | BEFORE | AFTER | IMPACT | EVIDENCE | FILES | STATUS |
|---|---|---|---|---|---|---|---|
| **K-17 / G-02 / N-07** | **P1 → P0 in effect** | Cancelling a paid order permanently destroyed its stock. The fix was wired into **one of three** cancel paths. The bulk-cancel action and the status dropdown both wrote `cancelled` and wrote the units off for good — and the single-order screen shipped **both behaviours side by side**, a "Cancel" button that restocked and a "Cancelled" dropdown option one row over that did not, with nothing to tell an operator apart. | The restock happens at the **only** function that writes a fulfilment status, so every path that can cancel returns the stock by construction. | Silent, permanent stock write-off on the two most-used admin paths — money on the shelf that the system believes is gone, and overselling once the counts drift. | **Verified this session by exhausting the writer set, not by trusting the comment.** Every `fulfillment_status` write in `app/` and `lib/` was enumerated; only two write a computed status, and the second (the Shippo tracking webhook) provably cannot produce `cancelled` — `TRACKING_STATUS_MAP` maps only to `label_purchased/in_transit/out_for_delivery/delivered/returned`. **There is no fourth path.** **Mutations M2 (delete the restock) and M3 (invert the post-label guard) — both caught.** | `lib/shippo/service.ts`, `lib/order-cancellation-inventory.ts`, `lib/admin-orders.ts`, `api/admin/orders/[orderId]/route.ts` | **CODE ONLY · VERIFIED** |
| **N-07b** | P1 | Cancelling an order whose postage was already bought would have restocked units that may already be with the carrier — inventing stock. | `label_purchased → cancelled` raises a `cancellation_after_label_purchase` warning and deliberately does **not** restock. A human decides. | Phantom stock, then overselling. | Read + **mutation M3 caught**. | `lib/shippo/service.ts` | **CODE ONLY · VERIFIED** |
| **N-02** | **P0** | Cancelling a **manually-paid** order wrote off its stock. The "the paid side effects ran" flag was written in exactly one place in the codebase — the card lane — so for every manually-approved order the system answered "no, the stock was never taken" and released a reservation that no longer existed. It reported "released". | The manual lane stamps the same flag, **last**, after the stock has actually moved. | Every manually-approved order that was later cancelled destroyed its own stock and said it had returned it. | Read this session: placement is correct and the failure direction is the conservative one — a crash between the decrement and the flag under-restocks (recoverable) rather than inventing units (oversell). **Mutation M6 — 4 tests failed.** | `lib/payment-webhook.ts` | **CODE ONLY · VERIFIED** |
| **N-02b** | **P0** | `claimInventoryRestock` returned `false` for two opposite facts: "somebody already returned these units" and "the claim could not be evaluated at all". A missing column was reported to the operator as *already returned*. | Three outcomes: `claimed` / `already_claimed` / `unavailable`. `unavailable` raises a **critical** alert and returns no stock. | A failure wearing a success's clothes — how the whole return path became inert with nobody noticing. | Read + **mutation M1 caught**. **Production query this session: `orders.inventory_restocked_at` DOES NOT EXIST.** So today every call returns `unavailable`. | `lib/inventory-fulfillment.ts`, `lib/order-cancellation-inventory.ts` | **CODE ONLY · VERIFIED · needs `sql/add-inventory-restock-claim.sql` — DEPLOY BLOCKER** |
| **D-04 / J-02** | **P0** | Saving an ordinary product edit switched off oversell protection and discarded live reservations. | Save no longer touches those fields. | An admin doing routine work disarms the store's only oversell guard. | Block D + Block J | product admin | **CODE ONLY** |
| **N-03** | P1 | Adding a new dose to a product stole `is_default` and `position` from the existing one — a regression introduced by the audit itself. | The new dose takes neither. | The wrong dose becomes the default customers see and buy. | `dose-replacement-preserves-inventory.test.ts` | `lib/admin-products.ts` | **CODE ONLY** |
| **E-B-04** | P1 | A broken inventory function could report success and take nothing off the shelf. | 12 tests. | Silent overselling. | 12 tests | test suite | **CODE ONLY** |
| **K-13** | P1 | The "15-minute" inventory hold was actually up to 45 minutes, and every failure reported success. | Corrected and failures surface. | Stock held far longer than promised; failures invisible. | Block M Phase 4.8 | reservation model | **CODE ONLY** |
| **G-03** | P2 | A checkout that dies at the processor left the order and its stock hold behind. | Handled. | Stock held for orders that will never be paid. | Browser-proven, Block M §6.3 | checkout | **CODE ONLY** |
| **G-05** | P3 | Sales never appeared in the inventory ledger. | — | Audit trail gap. | — | — | **STILL OPEN** |

## Payment processing · Order creation · Payment webhooks · Idempotency

| id | sev | BEFORE | AFTER | IMPACT | EVIDENCE | FILES | STATUS |
|---|---|---|---|---|---|---|---|
| **D-01** | **P0** | Every shipping-status write was a lost-update race — two admins, or an admin and a carrier webhook, could silently overwrite each other. | Guarded compare-and-set; the loser is told to reload. | Orders quietly reverting to an earlier state. | Block D | shippo service | **CODE ONLY** |
| **D-02 / J-01** | **P0** | A repeated carrier event re-ran in full and resurrected the cost of a label that had been voided. | Exactly-once claim. | Finalised profit rewritten by a replayed webhook. | Block D + J | shippo service | **CODE ONLY** |
| **J-04** | P1 | One schema drift disabled the duplicate-charge guard and blanked the tax trail at the same time. | Fixed. | Double charges; untraceable tax. | Block J | checkout | **CODE ONLY** |
| **D-05** | **P0** | A membership upgrade moved the perks but not the price — the processor kept charging the old tier. | Price moves with the tier. | Customers on a higher plan paying the lower price, indefinitely. | Block D | membership billing | **CODE ONLY** |
| **E-B-05** | **P0** | The function that takes membership money had zero test coverage. | 15 tests. | Unguarded money path. | 15 tests | test suite | **CODE ONLY** |
| **K-19** | P1 | Every call to the payment processor had no timeout. | Deadlines added. | A hung processor call hangs a checkout indefinitely. | Block M Phase 4.4 | payment client | **CODE ONLY** |
| **D-03** | P1 | A test named "dedupes a repeated purchase event" asserted only that a source string appeared. A **placebo**. | Replaced with a behavioural test. | The dedupe guard could have been deleted and the suite stayed green. | Block D | test suite | **CODE ONLY** |

## Coupons / promotions · Cart

| id | sev | BEFORE | AFTER | IMPACT | EVIDENCE | FILES | STATUS |
|---|---|---|---|---|---|---|---|
| **C-06** | **P1 launch blocker** | A failed email re-armed cart recovery, so the store re-sent the same message every 30 minutes, forever. | Failure no longer re-arms. | Customers spammed every half hour. Deliverability and brand damage. | 19 tests, 3 mutation controls | `cart-recovery.ts` | **CODE ONLY** |
| **K-05** | P1 | The 72-hour "last chance" email shipped a **dead coupon** and printed the literal text `SEE PREVIOUS EMAIL`. | Live coupon, real text. | Customers sent a broken offer in the store's own voice. | Block K | recovery templates | **CODE ONLY** |
| **K-01** | P2 | Coupon expiry times were stated in UTC, so customers were told the wrong deadline. | Local time. | Offers appearing to expire at the wrong hour. | Block K | recovery templates | **CODE ONLY** |
| **K-25** | P1 | Shipping protection was **pre-ticked**, against the store's own published Shipping Policy. | Unticked by default. | Charging for an add-on nobody chose, contradicting a published policy. Consumer-law exposure. | Block K | checkout UI | **CODE ONLY** |
| **E-B-07** | P1 | Coupon fuzzing that was fuzzing nothing. | Real fuzzing. | False confidence. | Block E-B | test suite | **CODE ONLY** |

## Marketing email / abandoned carts · Order email

| id | sev | BEFORE | AFTER | IMPACT | EVIDENCE | FILES | STATUS |
|---|---|---|---|---|---|---|---|
| **C-02** | **P0** | The retry sweep delivered a receipt and then left the send-once slot open, so the same receipt could go again. | Slot closed on delivery. | Duplicate receipts; customer confusion about whether they were charged twice. | 3 red tests first; fixed in Block M Phase 4.2, with a safety invariant deliberately widened and inverted while widening | `email/retry-queue.ts` | **CODE ONLY · MIGRATION STAGED** (`pending_emails.order_id` — **verified absent from production this session**) |
| **F-A-19** | P2 | A paging helper stopped on any short page, so a large audience read could quietly return only part of it — including mailing people who had unsubscribed. | Deleted; one shared helper that probes past its ceiling. | Emailing unsubscribed customers. Legal exposure under CAN-SPAM/GDPR. | Block M Phase 4.7 | `readAllRows` deleted | **CODE ONLY** |
| **F-014 / E-A-01** | P1 | Database-backed proofs **skipped silently**, and `vitest.setup.ts` globally stubbed eleven whole subsystems for every suite. | Banners added; nine stubs removed. | Fourteen tests skipped silently while the run reported success. | Block A+B / E-A | `vitest.setup.ts`, both DB suites | **CODE ONLY — INCOMPLETE, see STILL OPEN** |

## Fulfillment · Shippo / shipping

| id | sev | BEFORE | AFTER | IMPACT | EVIDENCE | FILES | STATUS |
|---|---|---|---|---|---|---|---|
| **M-02** | P1 | The reconciliation screen died outright on a missing optional column. | Degrades instead of dying. | An admin money screen showing an error page. | Block M Phase 4.0, on a local Postgres | `admin-reconciliation.ts` | **CODE ONLY** |
| **C-03 / C-04** | P1 | The admin order page's shipping-email branch was dead code using the wrong template; a single parcel could send two shipping emails. | — | Duplicate or wrong customer email. | Filed, cross-block | — | **STILL OPEN** |

## Financial reporting (profit / revenue / tax / reconciliation)

| id | sev | BEFORE | AFTER | IMPACT | EVIDENCE | FILES | STATUS |
|---|---|---|---|---|---|---|---|
| **F-A-01** | P1 | Reconciliation could not see a mismatch older than 2,000 orders. | Pages to exhaustion. | Money discrepancies invisible past 2,000 orders. | `financial-reporting-row-caps.test.ts` — **7 tests, run for the first time this session against real Postgres, all pass.** | `admin-reconciliation.ts` | **CODE ONLY · VERIFIED** |
| **F-A-02** | P1 | The profit dashboard truncated lifetime figures at 20,000 orders. | Pages to exhaustion. | Understated lifetime profit. | Same suite | `admin-profit.ts` | **CODE ONLY · VERIFIED** |
| **F-A-03** | P1 | The revenue page reported two different lifetime totals depending on whether a migration had run. | One total. | Two numbers for the same question. | `financial-reporting-consistency.test.ts` — **8 tests, first run this session, pass.** | `admin-revenue.ts` | **CODE ONLY · VERIFIED** |
| **F-A-04** | P1 | The sales-tax filing report stopped after 20 pages. | Complete. | **Under-reporting tax owed to a state.** Filing exposure. | Same suite | `admin-tax-report.ts` | **CODE ONLY · VERIFIED** |
| **F-A-05 / K-27** | P1 | A partially refunded order vanished from the sales-tax return **entirely** — the store under-reported the tax it still owed on the part the customer kept. | Included, with proportional treatment. | Under-paying a state tax authority. | `admin-financial-surfaces.test.ts` — **21 tests, first run this session, pass.** | `admin-tax-report.ts` | **CODE ONLY · VERIFIED** |
| **F-A-06** | P1 | A refund deducted from net tax whose collection had never been recorded. | Corrected. | Negative tax liability — a filing that cannot be true. | Same | `admin-tax-report.ts` | **CODE ONLY · VERIFIED** |
| **F-A-07** | P2 | Partial refunds had no proportional tax treatment. | Derived by ratio, with the assumption stated in the file because a filing is involved. | Wrong tax on every partial refund. | Same | `admin-tax-report.ts` | **CODE ONLY** |
| **F-A-12** | P1 | A refund removed sales tax from profit it had never been added to. | Corrected. | Profit understated on every refund. | Same | `admin-profit.ts` | **CODE ONLY** |
| **F-B-03** | P1 | A full refund produced a **negative** tax liability. | Clamped and corrected. | An impossible number on a filing report. | Block F-B | `admin-tax-report.ts` | **CODE ONLY** |
| **F-B-01** | P1 | Three screens labelled "paid orders" reported three different numbers. | Converged. | The owner cannot tell which screen to believe. | Block F-B | five modules | **CODE ONLY · one migration awaiting owner** |
| **F-B-04** | P2 | The customer's invoice did not add up — on three real orders in production today. | Adds up. | A customer can see the arithmetic is wrong. Trust and chargebacks. | Block F-B, against live rows | invoice | **CODE ONLY** |
| **F-B-05 / F-A-11** | P1 | Two money reads could return part of the store and say nothing about it. | Short reads are detected and reported. | Silently partial money figures. | Block F-A/F-B | reporting modules | **CODE ONLY · VERIFIED** |
| **F-A-09** | P2 | Two order counts inside the profit module disagreed. | One count. | Two answers on one screen. | Block F-A | `admin-profit.ts` | **CODE ONLY** |
| **F-A-10** | P3 | A **fifth** hand-copy of the loyalty points rate. | Single source. | Points drift between screens. | Block F-A | `admin-reconciliation.ts` | **CODE ONLY** |
| **F-A-17** | P2 | The cost-of-goods read returned many rows per order and was undefended. | Defended. | Wrong COGS, wrong profit. | Block F-A | `admin-profit.ts` | **CODE ONLY** |
| **F-A-18 / F-A-20 / F-A-21** | P2 | The shared test fake ignored paging entirely; two database suites shared one database; the row-caps suite carried its own hand-copy of the revenue SQL. | Fake models paging; suites isolated; SQL executed not copied. | Tests that could not detect the very defects they were written for. | Block F-A. **This session ran each DB suite in its own database** — the isolation fix holds. | test infrastructure | **CODE ONLY · VERIFIED** |
| **N-05** | P2 | A test asserted on the **text** of a SQL file rather than running it — a placebo, blind to the one defect in the file it guarded. | The rollup is executed against a real database. | A broken rollup would pass its own test. | `bulk-savings-rollup-executed.test.ts` — **3 tests, first run this session against real Postgres, pass.** | `sql/admin-dashboard-rollups.sql` | **CODE ONLY · VERIFIED** |
| **K-21** | P1 | The homepage hardcoded a "99%" claim and checkout made a different fulfilment promise. | Corrected and consistent. | Two contradictory published promises. Advertising exposure. | Block K | homepage, checkout | **CODE ONLY** |

## Security / RLS / RPC / secrets · Rate limiting

| id | sev | BEFORE | AFTER | IMPACT | EVIDENCE | FILES | STATUS |
|---|---|---|---|---|---|---|---|
| **I-07** | **P0** | `create_partner_invite` was an **unauthenticated, RLS-bypassing write** — anyone on the internet could create partner invites. | Locked down. | Arbitrary partner creation by a stranger. Direct fraud path. | **Remediated in production and verified.** Re-confirmed this session: the function exists in production with the hardened definition. | `sql` RPC | **LIVE IN PRODUCTION** |
| **I-01** | **P0** | Email-provider secrets were stored in plaintext in the admin audit log **and rendered by the log viewer**. | The read boundary is closed. | Anyone with admin log access could read the store's email credentials. | Block I | audit log viewer | **CODE ONLY — ROTATION STILL OWED BY THE OWNER** |
| **I-03 (+I-03b)** | P1 | Public rate limits were keyed on a header the client controls — trivially bypassed. | Keyed on something the client cannot set. | Rate limiting that does not limit. | Block I | `rate-limit.ts` | **CODE ONLY** |
| **I-05 (+I-05b)** | P1 | Product image upload trusted the client's declared file type and extension. | Content is checked. | Arbitrary file upload. | Block I | upload route | **CODE ONLY** |
| **I-08** | P1 | Four of eight CSV exporters allowed formula injection. | All eight escape. | A crafted order note executes when an admin opens the export in Excel. | Block I | CSV exporters | **CODE ONLY** |
| **I-09** | P3 | Four anonymous routes echoed raw internal errors. | Generic messages. | Internal structure leaked to anonymous callers. | Block I | routes | **CODE ONLY** |
| **I-10** | P3 | Admin login leaked whether a username existed, through response timing. | Constant-time. | Username enumeration. | Block I | `admin-auth.ts` | **CODE ONLY** |
| **I-04** | P3 | An ads route had no sweep protection and performed writes on `GET`. | Corrected. | State change from a crawler or prefetch. | Block I, severity corrected down from filing | ads route | **CODE ONLY** |
| **K-15 / N-06** | P1 | Rate limiting was read-then-write with no claim and **failed open silently** — it only stopped serial traffic. Then the repair itself amplified writes and let a user lock themselves out. | A bounded per-instance memo short-circuits an already-denied bucket and returns the same wait the database would. Capped at 10,000 entries with expiry-first eviction. | A throttle that does not throttle, then one that locks out real customers. | Read this session — bound and eviction are correct. **Mutations M8 (never short-circuit) and M9 (never evict) — both caught.** | `lib/rate-limit.ts` | **CODE ONLY · VERIFIED** |
| **K-16** | P1 | Three **live production ad-pixel IDs** were hardcoded as environment fallbacks with no environment guard, so preview and local builds fired real production pixels. | Guarded. | Polluted ad attribution and real ad spend driven by test traffic. | Block K | analytics config | **CODE ONLY** |
| **F-010** | P2 | RLS posture reviewed: 68/68 tables enabled, four issues noted. | Recorded. | — | Block A+B | — | **RECORDED** |
| **F-011** | P1 | Three safety-critical database functions existed **only in production**, in no source file. | Baselined into the repository. | An innocent redeploy could delete them. | Block A+B | `sql/BASELINE-live-functions-2026-08-25.sql` | **CODE ONLY (baseline captured)** |

## Memberships

| id | sev | BEFORE | AFTER | IMPACT | EVIDENCE | FILES | STATUS |
|---|---|---|---|---|---|---|---|
| **K-07** | P1 | "One skip per paid period" allowed **two** skips inside the reminder window. | One. | Customers skipping a period they paid for twice. Direct revenue loss. | Block K | `membership-billing.ts` | **CODE ONLY** |
| **D-05** | P0 | (see Payment) upgrade moved perks, not price. | | | | | **CODE ONLY** |

## Tests & test infrastructure

| id | sev | BEFORE | AFTER | IMPACT | EVIDENCE | FILES | STATUS |
|---|---|---|---|---|---|---|---|
| **E-A-02** | P1 | Mutation testing across six clusters: 14 mutants, **2 real survivors**. | Both closed. | Two real blind spots in the suite. | Block E-A | test suite | **CODE ONLY** |
| **E-B-01** | P2 | A placebo that failed on a harmless refactor and would have passed on the actual bug. | Replaced. | Worse than no test. | Block E-B | test suite | **CODE ONLY** |
| **E-B-06 / E-B-08** | — | Findings that **disprove** parts of the system map; the eleven global stubs documented. | Recorded. | — | Block E-B | — | **RECORDED** |
| **Block N test suite** | — | 1,612 new test lines, unread. | — | — | **This session ran nine real mutations against the production code they guard. Nine caught, zero survivors.** No placebo found among them. | 8 new/changed test files | **VERIFIED** |

## Storefront / UI · Copy / trust claims / COAs · Analytics / consent

| id | sev | BEFORE | AFTER | IMPACT | EVIDENCE | FILES | STATUS |
|---|---|---|---|---|---|---|---|
| **F-001** | P1 | 31 of 36 products are dose-stocked with a zero parent count and must still render "In Stock". | Confirmed correct behaviour. | Would have read as the whole catalogue being out of stock. | **Browser-proven by Block G+H.** | — | **VERIFIED (browser, Block G+H)** |
| **F-004** | P2 | A historical repair was structurally present but unproven. | Browser-proven. | — | Block G+H | — | **VERIFIED (browser)** |
| **K-21** | P1 | (see Financial) contradictory published promises. | | | | | **CODE ONLY** |

---

# STILL OPEN

Every unfixed item, with the category that closes it. Four categories are
allowed; **anything fitting none of them should have been fixed and is flagged.**

## A. Owner's business decision

| id | what closes it |
|---|---|
| D-07 | Bac Water is the one sellable unit with no oversell protection — owner decides whether to stock-track it. |
| I-06 | The product-image route advertises GIF; the storage bucket rejects it. Owner: support GIF, or stop advertising it. |
| I-02 | Capability-gate gap, narrower than filed; the money path is dead code. Owner decides the intended gate. |
| K-02 | Both cart-recovery templates hardcode "5% off" while the discount is admin-configurable. Owner sets the rule. |
| K-10 | The offers bar says "Ends tonight" for a coupon expiring that morning and for one a year away. |
| K-18 | Four compliance attestations are collected and **none is durably recorded** on the card lane. Needs 3 columns — and a decision about retention. **Legal exposure; recommend treating as a launch blocker.** |
| K-20 | Four tables written and never read; two double the visitor data retained. Owner decides retention. |
| K-22 | A coupon that loses the discount competition is still marked redeemed. |
| J-06 | Is the free Buy-3-Get-1 unit reserved? Untested; owner defines intent. |
| J-08 | The NULL `order_number` row — recommendation is to leave it. |
| **returned parcels** | *Found this session:* `returned` is a terminal fulfilment status and **does not restock**. Whether a returned parcel returns to sellable stock is a business decision that nothing in the audit has recorded. |

## B. Needs production approval (a migration or a live change)

| id | what closes it |
|---|---|
| **G-01 / M-01** | Apply `sql/referral-orders-commission-lifecycle.sql`. **Verified still unapplied this session. Hard deploy blocker.** |
| **K-17 / G-02 / N-02b** | Apply `sql/add-inventory-restock-claim.sql`. **`orders.inventory_restocked_at` verified absent this session. Hard deploy blocker.** |
| **C-02** | Apply the `pending_emails.order_id` migration. **Verified absent this session.** |
| G-04 / I-12 (residual) | Apply the inventory-RPC migration (STEP 2). `adjust_inventory_on_sale` **verified absent from production this session**; `finalize_inventory_for_order` **verified present**. |
| I-11 | The RPC lockdown is point-in-time and the mechanism that reopened it is **still armed**. Cannot be fully closed from inside the repository. |
| C-10 | Automation dedupe is read-then-write with no unique constraint — needs a schema change. |
| F-B-01 | One migration awaiting owner. |
| Step 5b | Drop the duplicate rate-limit index. Moved from optional to **run-before-deploy**. |

## C. External dependency

| id | what closes it |
|---|---|
| F-006 / K-21 | **Zero COAs exist** while the storefront advertises COA documentation in the footer and the age gate. Publishing them is owner+lab work. **Legal exposure. Launch blocker.** |
| I-01 (rotation) | The exposed email-provider credentials must be **rotated by the owner** and the historical audit rows purged. The code fix does not undo the exposure. |
| H-01 | The runbook's mock-payment setup is not achievable as written — runbook fix. |

## D. Cannot be safely verified from here

| id | why |
|---|---|
| Live VeyraGate callback | Would require a real charge. Prohibited. |
| RLS correctness, GoTrue, realtime | The harness has neither. |
| `membership-billing.ts:520` cross-repo claim | Asserts behaviour of a different repository. Unverifiable from here and should not be asserted. |

## E. **FITS NO CATEGORY — SHOULD HAVE BEEN FIXED** (flagged, as instructed)

| item | why it is flagged |
|---|---|
| **`isShippoLive()` — zero callers** | A comment states "every money-spending path checks this". **Verified this session: the function appears exactly once in the repo, its own definition.** This is the identical shape as N-04, which *was* fixed. It is dead code guarding money with a false comment on top, and there is no decision to be made — it is either wired up or deleted. |
| **`admin-tax-report.ts:77` ↔ `admin-profit.ts:88`** | Each names the other as the shared source of truth for refunded tax and **they are not identical** (verified this session — the profit version has no `status=='refunded'` fallback, so for a refunded order with no recorded refund amount one report counts the whole tax and the other counts zero). Latent only because production has **zero refunded orders** (verified). Both comments are false today. |
| **The three silent test skips** | `admin-financial-surfaces`, `financial-reporting-consistency` and `financial-reporting-row-caps` disable themselves with **no banner** — 36 assertions vanishing quietly. F-014 fixed exactly this for two suites and left three. A one-line `console.warn` closes it. |
| **The 22 outstanding cross-module claims** | 20 are listed in `INTEGRATION-LOG.md`; **the register says 28 and lists 26** (verified by counting), so two are named in the totals and absent from the document. Whatever the fix, the register must first be made complete. |

### The 22 outstanding cross-module claims, as listed

**P1 (2):** `payment-mock.ts:6` (a passing mock payment does not certify the live
callback); `cart-recovery.ts:268` (`resendCartRecoveryEmail` reaches the coupon
mint on a path the unique index does not cover).

**P2 (16 listed):** `cart-recovery.ts:215`, `email/retry-queue.ts:216`,
`email/audience.ts:234`, `shippo/config.ts:49`, `shippo/client.ts:472`,
`shippo/service.ts:115`, `shippo/parcel.ts:19`, `admin-auth.ts:220`,
`membership-billing.ts:1342`, `express-reconcile.ts:81`,
`order-attribution.ts:78`, `referral-code-validation.ts:30`,
`partner-portal.ts:1013`, `admin-tax-report.ts:77`, `admin-profit.ts:88`,
`reconciliation-math.ts:13`.

**P3 (2):** `partner-portal.ts:1570`, `membership-billing.ts:520`.

**2 unlisted** — named in the totals, absent from the register.

---

# DISPROVED

Filed as defects, established as non-defects. Recorded so nobody resurrects
them. **Each was re-checked in this session rather than copied.**

| id | the claim | the refutation |
|---|---|---|
| **I-12** | "`adjust_inventory_on_sale` is missing from production, therefore paid orders never decrement stock." | The premise is true, the consequence is false. **Verified this session by direct production query:** `adjust_inventory_on_sale` is **absent**, but `finalize_inventory_for_order` — the function the code actually calls on the paid path — is **present**. Stock does decrement. Downgraded to G-04, P2 latent. |
| **F-005** | A Sentry alert indicated a live defect. | The alert was right; the first *reading* of it was wrong. No defect. |
| **F-007** | The affiliate marketing figures on the site are inflated/false. | They are a deliberate pre-launch floor, not a claim about achieved performance. |
| **F-A-08** | `expectedOrderTotal` disagrees with the charged formula. | It agrees. Two latent risks were recorded separately (F-A-16) rather than filed as this defect. |
| **F-A-15** | The two processing-fee constants have drifted. | They agree, **and they are two different concepts** — `DEFAULT_CARD_PROCESSING_FEE` (the customer-facing surcharge config) and `config.processingFeePercent` (the cost input to the profit calculation). Merging them would be a new defect. Confirmed by reading both this session. |
| *(10 more)* | Block K recorded ten additional explicitly disproven leads in `findings/BLOCK-K.md`. | Not individually re-verified here. |

**Two corrections to the brief that commissioned this review**, both verified:

1. The brief lists "**F-15**" among the disproved. **F-015 is "no CI exists at
   all", P1, and it is CONFIRMED OPEN** — `.github/` does not exist in this
   repository at all. The disproved finding is **F-A-15**. Two different
   findings, one character apart.
2. The brief states `reserve_inventory` is not in production, following the
   Block N register. **It is.** Production query this session returned
   `reserve_inventory`, `expire_stale_reservations` and
   `finalize_inventory_for_order` all present. That register row is wrong.

---

# NOT VERIFIED

Unproven, with the real launch risk and the exact test that closes it.

| item | risk | the test that closes it |
|---|---|---|
| **The live VeyraGate callback** | The mock and the live envelope differ in more than origin: a live callback carries a charge and no shopper, and the `payment_id` join plus the `isRecognisedMoneyEvent` guard have **zero mock coverage**. A payment could succeed at the processor and not become an order. | One real low-value card transaction in a sandbox/live-test mode, followed end to end. Requires the owner. |
| **Real card entry in the browser** | The payment form itself has never been driven with a card. | Browser test against the processor's test mode. |
| **Signed-in flows, RLS correctness, realtime** | The harness has no GoTrue and no RLS. A policy could be wrong in a way nothing here can see. | An RLS test suite against a Supabase branch with auth enabled. |
| **The purchase flow on THIS head** | Block M browser-proved a full purchase on code contained in this branch; this session did not repeat it, and Block N's seven commits landed afterwards. | Re-run `BROWSER-TESTING-RUNBOOK.md` §cart→order against the harness on a production build of `eb80a55`. |
| **All three cancel paths in the browser** | Proven by code exhaustion and mutation, **not** by clicking all three admin surfaces. | Cancel one order per path in the admin UI against the harness, checking the stock count after each. |
| **Any behaviour under production data volume** | Production has 15 orders. Every row-cap and paging defect in this audit is invisible at that size. | The row-cap suites — which **do** now run, against a generated dataset (this session). Closed for reporting; open for everything else. |
| **The commission accrual against a live ambassador sale** | Blocked by the unapplied migration. | Apply the migration to a Supabase branch, place a referred order, confirm exactly one `referral_orders` row at the configured rate. |
