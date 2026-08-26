# Block M — Integration Log

**Purpose.** This file is the resume point. Block M is larger than one context
window, so every unit of work is appended here and committed immediately. If this
session is interrupted, **resume from this file, never from memory.**

Companion files: [`AUDIT-EXECUTION-PLAN.md`](./AUDIT-EXECUTION-PLAN.md) ·
[`AUDIT-PARALLEL-ASSIGNMENTS.md`](./AUDIT-PARALLEL-ASSIGNMENTS.md) ·
[`AUDIT-COVERAGE-MATRIX.md`](./AUDIT-COVERAGE-MATRIX.md) ·
[`FINAL-CERTIFICATION-AUDIT.md`](./FINAL-CERTIFICATION-AUDIT.md) ·
[`BROWSER-TESTING-RUNBOOK.md`](./BROWSER-TESTING-RUNBOOK.md)

---

# PHASE 1 — INVENTORY

Read-only. No code changed in this phase.

## 1.1 Branch census — and two branches the brief did not list

Every remote branch was scanned for `website/docs/findings/` and for the ledger.
Nine branches carry audit work. **All nine fork from `main` at `9aea901`.**

| # | Branch | Block | Findings file(s) | Commits ahead of main |
|---|---|---|---|---|
| 1 | `claude/audit-superpowers-playwright-extension-c2oyhm` | **base / audit branch** | — (`BROWSER-TESTING-RUNBOOK.md`, PostgREST shim) | 12 |
| 2 | `claude/vanta-labs-audit-resume-754dol` | **A+B** | *(no block file — its findings are `F-013`…`F-019` in the ledger)* | 17 |
| 3 | `claude/block-ab-audit-zuuyuz` | **C**, **E** | `BLOCK-C.md`, `BLOCK-E.md` | 21 |
| 4 | `claude/block-ab-audit-8xz6fb` | **D**, **J** | `BLOCK-D.md`, `BLOCK-J.md` | 19 |
| 5 | `claude/audit-blocks-f-e-8jxi9v` | **E**, **F** | `BLOCK-E.md`, `BLOCK-F.md` | 20 |
| 6 | `claude/block-ab-audit-o62bop` | **F** | `BLOCK-F.md`, `BLOCK-F-PRODUCTION-CHANGES.md` | 16 |
| 7 | `claude/browser-testing-blocks-gh-egmzo3` | **G+H** | `BLOCK-GH.md` | 14 |
| 8 | `claude/block-ab-audit-6fogsm` | **I** | `BLOCK-I.md` | 23 |
| 9 | `claude/audit-parallel-assignments-block-k-r8fpix` | **K** | `BLOCK-K.md` | 40 |

**Two corrections to the brief's branch list, both material:**

1. **`browser-testing-blocks-gh-egmzo3` (Block G+H) was not in the brief's list.**
   It is the only branch that ever exercised checkout in a browser, and it holds
   the single most important piece of evidence in the audit — *and* the
   disproof of I‑12 (§1.5). Omitting it would have lost the one complete purchase.
2. **`audit-superpowers-playwright-extension-c2oyhm` is the audit branch**, not
   `vanta-labs-audit-resume-754dol`. Every block branch's merge-base with it is
   `4f8a936`/`751f662` — i.e. all eight descend from it. `754dol` diverged
   earlier (at `15ac25f`), merged `c2oyhm` back in at `6fab676`, and is
   **Block A+B's session**: its 17 commits are the admin-invite door (F‑013), the
   commission-sweep race (F‑016), the approval-email rate (F‑017), the
   `updatePartnerStatus` no-op (F‑018) and the split accrual/payout gates (F‑019).
   Block J filed a warning that "Block A+B has no findings file"; that is true of
   `findings/BLOCK-AB.md`, but **the work exists** — it is in the ledger, on
   branch 2. Block J's rows 1, 6, 8, 11, 12, 14, 38 and 41 can now be re-graded.

`vanta-labs-audit-resume-754dol` also carries `FINAL-CERTIFICATION-REPORT.md`, an
interim verdict written before blocks C–K existed. It is superseded by this
block's certification and is treated as history, not as input.

## 1.2 The ID collisions, resolved before any merge

Two pairs of block files number different defects identically.

| Colliding id | Branch | Actual defect | Renumbered to |
|---|---|---|---|
| `F-01` | `o62bop` | reconciliation cannot see a mismatch older than 2,000 orders | **`F-A-01`** |
| `F-01` | `8jxi9v` | three surfaces labelled "paid orders" report three different numbers | **`F-B-01`** |
| `E-01` | `zuuyuz` | `vitest.setup.ts` stubbed eleven modules for every suite | **`E-A-01`** |
| `E-01` | `8jxi9v` | a placebo that failed on a refactor and would pass on the bug | **`E-B-01`** |

**Scheme adopted for the whole audit:**

- `o62bop` Block F: `F-01…F-21` → **`F-A-01…F-A-21`**
- `8jxi9v` Block F: `F-01…F-05` → **`F-B-01…F-B-05`**
- `zuuyuz` Block E: `E-01…E-02` → **`E-A-01…E-A-02`**
- `8jxi9v` Block E: `E-01…E-08` → **`E-B-01…E-B-08`**
- The ledger keeps three-digit `F-001…F-019`. Three digits vs `F-A-`/`F-B-` makes
  every reference unambiguous, and **no existing id in any file is rewritten**,
  so every cross-reference already written by another block still resolves.
- `C-`, `D-`, `G-`, `H-`, `I-`, `J-`, `K-` are already unique and are untouched.

**The two F blocks are not merely id-colliding — they overlap semantically.**
Both were assigned "Block F — financial reporting" and both rewrote the same five
modules. Several defects are the *same* defect found twice:

| Same defect | `F-A` | `F-B` |
|---|---|---|
| reconciliation capped at newest 2,000 orders | `F-A-01` | `F-B-05(a)` |
| sales tax drops / mishandles partial refunds | `F-A-05`, `F-A-07` | `F-B-03` |
| profit dashboard row caps / short reads | `F-A-02`, `F-A-11` | `F-B-05` |
| surfaces disagree on what a paid order is | `F-A-03`, `F-A-09` | `F-B-01` |
| `expectedOrderTotal` is a hand-copy of the total formula | `F-A-08` (**DISPROVED**) | `F-B-02` (**drifted by 1¢, bounded**) |

That overlap is the hardest merge in this block and is handled in Phase 2.

## 1.3 Arithmetic assertion — nothing was eaten

Counted from the source files before any merge, then re-counted after.

| Block | File | IDs | Count |
|---|---|---|---|
| A+B & Phases 0–2 | `FINAL-CERTIFICATION-AUDIT.md` | `F-001…F-019` | **19** |
| C | `BLOCK-C.md` | `C-01…C-16` | **16** |
| D | `BLOCK-D.md` | `D-01…D-07` | **7** |
| E (zuuyuz) | `BLOCK-E.md` | `E-A-01…E-A-02` | **2** |
| E (8jxi9v) | `BLOCK-E.md` | `E-B-01…E-B-08` | **8** |
| F (o62bop) | `BLOCK-F.md` | `F-A-01…F-A-21` | **21** |
| F (8jxi9v) | `BLOCK-F.md` | `F-B-01…F-B-05` | **5** |
| G+H | `BLOCK-GH.md` | `G-01…G-05`, `H-01` | **6** |
| I | `BLOCK-I.md` | `I-01…I-12` | **12** |
| J | `BLOCK-J.md` | `J-01…J-09` | **9** |
| K | `BLOCK-K.md` | `K-01…K-23`, `K-25…K-27` (`K-24` never issued) | **26** |
| | | **SUM** | **131** |

Plus **2 sub-findings** (`I-03b`, `I-05b`) and **16 unnumbered** items in Block K's
closing sweep = **149 tracked items**.

`K-24` is a genuine gap in Block K's own numbering, not a lost finding: the file's
index jumps `K-23 → K-25` and every narrative reference is consistent with that.
Recorded so no later reader hunts for it.

**Post-consolidation count must equal 131 numbered + 2 sub + 16 unnumbered.**
Re-asserted at the end of Phase 2 and again in Phase 8.

## 1.4 Per-finding inventory

Severity, status and grade are **as filed by the owning block**, not re-graded here.
`FIXED` means fixed on that block's branch, not deployed — **zero application code
is in production.**

### Ledger — Block A+B and Phases 0–2 (branch `754dol`)

| id | title | sev | status as filed | files | migration? | cross-block |
|---|---|---|---|---|---|---|
| F-001 | 31 of 36 products are parent-zero / dose-stocked and must render In Stock | P1 | OPEN → **proven correct by G+H** | — | no | G+H |
| F-002 | partner/ambassador tables currently converged | info | RECORDED | — | no | — |
| F-003 | NULL `customer_discount_percent` is an intentional sentinel | info | RECORDED | — | no | — |
| F-004 | historical bug #1 repair structurally present | P2 | OPEN → **browser-proven by G+H** | — | no | G+H |
| F-005 | Sentry alert was right; first reading wrong | — | **DISPROVED** | — | no | — |
| F-006 | zero COAs exist, storefront advertises COA documentation | P1 | OPEN — external dependency | `site-footer.tsx:67`, `age-gate.tsx:483` | no | K-21 |
| F-007 | affiliate marketing figures are a deliberate pre-launch floor | — | **DISPROVED** | — | no | — |
| F-008 | order-status drift on one cancelled order | P3 | OPEN (data) | — | no | — |
| F-009 | pre-added ambassador can never apply | P0 | **FIXED + APPLIED TO PRODUCTION** | `partner-portal.ts`, `sql/partner-identity-convergence.sql` | ✅ applied | — |
| F-010 | RLS posture 68/68 enabled, four issues noted | P2 | RECORDED | — | no | I |
| F-011 | three safety-critical DB functions exist only in production | P1 | BASELINED | `sql/BASELINE-live-functions-2026-08-25.sql` | no | M/Phase 5 |
| F-012 | orders that never reached the processor are never retired | P2 | OPEN | — | no | — |
| F-013 | admin invite door reopens BRUTUS, defeats the F-009 repair | P0 | **FIXED + APPLIED TO PRODUCTION** | `partner-portal.ts`, `sql/partner-invite-convergence.sql` | ✅ applied | — |
| F-014 | database-backed proofs skip silently | P1 | **FIXED (repo)** | both DB suites | no | E |
| F-015 | no CI exists at all | P1 | OPEN — owner | — | no | — |
| F-016 | commission sweep overwrites money that moved while deciding | P0 | **FIXED (repo)** | `partner-portal.ts` | no | — |
| F-017 | approval email quotes a commission the ambassador does not earn (**historical #3**) | P0 | **FIXED (repo)** | `partner-portal.ts` | no | C-01 |
| F-018 | approving an ambassador with no `ambassadors` row reported false success | P0 | **FIXED (repo)** | `partner-portal.ts` | no | — |
| F-019 | accrual and payout release gated by different tables | P0 | **FIXED (repo)** | `partner-portal.ts` | no | — |

### Block C — Email (branch `zuuyuz`)

| id | title | sev | status as filed | migration? | cross-block |
|---|---|---|---|---|---|
| C-01 | approval email quotes rate from the non-authoritative table (**historical #3**) | P0 | CONFIRMED — **fix blocked**, 4 RED tests committed | no | A+B (`partner-portal.ts`) |
| C-02 | retry sweep delivers a receipt without closing the send-once slot | P0 | CONFIRMED — needs owner (schema), 3 RED tests committed | **yes** | owner |
| C-03 | admin order page's shipping-email branch is dead code, wrong template | P1 | CONFIRMED — cross-block | no | I |
| C-04 | two shipping emails for one parcel | P1 | CONFIRMED — cross-block | no | I, D |
| C-05 | refund email cannot be retried, deduped, or traced | P1 | CONFIRMED — cross-block | no | A+B |
| C-06 | failed send re-arms cart-recovery, re-sends every 30 min | P1 launch blocker | ✅ **FIXED** (19 tests, 3 controls) | no | — |
| C-07 | `vitest.setup.ts` globally stubs whole subsystems | P1 | CONFIRMED — cross-block | no | E |
| C-08 | 21 of 36 `sendEmail` call sites discard the result | P1 | CONFIRMED — mixed ownership | no | many |
| C-09 | coupon broadcast counts a FAILED send as already sent | P2 | CONFIRMED — cross-block | no | `marketing-broadcast.ts` |
| C-10 | automation dedupe is read-then-write, no unique constraint | P2 | CONFIRMED — schema change | **yes** | owner |
| C-11 | two admin resend paths bypass send-once entirely | P2 | CONFIRMED — cross-block | no | I |
| C-12 | communications panel ignores its own proof; retry resends wrong mail | P2 | CONFIRMED — cross-block | no | `order-communications.ts` |
| C-13 | resuming a stopped campaign mails nobody, reports full audience | P3 | CONFIRMED — cross-block | no | `campaign-sender.ts` |
| C-14 | membership receipts have no claim, unlike the reminders beside them | P3 | CONFIRMED — cross-block | no | D/K (`membership-billing.ts`) |
| C-15 | auth email is a separate unmonitored channel; settings file says otherwise | P3 | CONFIRMED — doc/monitoring | no | — |
| C-16 | `notification_queue` is not a queue: no consumer, no retry | P2 | CONFIRMED — cross-block | no | A+B |

### Block D — Fulfillment / inventory / discounts (branch `8xz6fb`)

| id | title | sev | status as filed | migration? |
|---|---|---|---|---|
| D-01 | every shipping status write is a lost-update race | P0 | ✅ FIXED (repo) | no |
| D-02 | `transaction_created` re-runs in full on redelivery; voided label cost resurrected | P0 | ✅ FIXED (repo) | no |
| D-03 | a "dedupes a repeated purchase event" test asserted only a source substring | P1 | ✅ FIXED (repo) | no |
| D-04 | saving a product edit switches off oversell protection, discards reservations | P0 | ✅ FIXED (repo) | no |
| D-05 | membership upgrade moves the perks but not the price; Veyra keeps charging old tier | P0 | ✅ FIXED (repo) | no |
| D-06 | `startMembershipSignup` globally mocked out, untestable | P1 | **OPEN** | no |
| D-07 | Bac Water is the one sellable unit with no oversell protection | P1 | **OPEN — owner decision** | data |

### Block E-A — Test quality (branch `zuuyuz`)

| id | title | sev | status |
|---|---|---|---|
| E-A-01 | `vitest.setup.ts` stubbed eleven modules for every suite; nine load-bearing for nothing | P1 | ✅ FIXED |
| E-A-02 | mutation testing six clusters: 14 mutants, 2 real survivors, both closed | P1 | ✅ FIXED |

### Block E-B — Test quality (branch `8jxi9v`)

| id | title | sev | status |
|---|---|---|---|
| E-B-01 | a placebo that failed on a refactor and would pass on the bug | P2 | ✅ REPLACED |
| E-B-02 | the commission rate an ambassador is paid had no behavioural test | P0 | ✅ FIXED (19 tests) |
| E-B-03 | nobody could send an ambassador money wrongly and be noticed | P0 | ✅ FIXED (13 tests) |
| E-B-04 | a broken inventory RPC could report success and take nothing off the shelf | P1 | ✅ FIXED (12 tests) |
| E-B-05 | the function that takes membership money had zero coverage | P0 | ✅ FIXED (15 tests) |
| E-B-06 | findings that DISPROVE parts of the map | — | RECORDED |
| E-B-07 | coupon fuzzing that was fuzzing nothing | P1 | ✅ FIXED |
| E-B-08 | the eleven global stubs are now documented | — | RECORDED |

### Block F-A — Financial reporting (branch `o62bop`)

| id | title | sev | status |
|---|---|---|---|
| F-A-01 | reconciliation cannot see a mismatch older than 2,000 orders | P1 | ✅ FIXED |
| F-A-02 | profit dashboard truncates lifetime figures at 20,000 orders | P1 | ✅ FIXED |
| F-A-03 | revenue page reports two different lifetime totals depending on a migration | P1 | ✅ FIXED |
| F-A-04 | sales-tax filing report stops after 20 pages | P1 | ✅ FIXED |
| F-A-05 | a partially refunded order was absent from the sales-tax return entirely | P1 | ✅ FIXED |
| F-A-06 | a refund deducted from net tax without its collection ever recorded | P1 | ✅ FIXED |
| F-A-07 | partial refunds had no proportional tax treatment | P2 | ✅ FIXED (stated assumption) |
| F-A-08 | `expectedOrderTotal` agrees with the charged formula | — | **DISPROVED** (2 latent risks recorded) |
| F-A-09 | two order counts in `admin-profit.ts` disagreed | P2 | ✅ FIXED |
| F-A-10 | `admin-reconciliation` carried a fifth hand-copy of the points rate | P3 | ✅ FIXED |
| F-A-11 | nothing detected a short read from the row source | P1 | ✅ FIXED |
| F-A-12 | a refund removed sales tax from profit it was never added to | P1 | ✅ FIXED |
| F-A-13 | degraded checkout insert blanks the tax jurisdiction | P1 | **OPEN — cross-block** |
| F-A-14 | manual postage entry finalizes profit while the order page stays blank | P2 | **OPEN — cross-block** |
| F-A-15 | the two processing-fee constants agree and are two concepts | P3 | **DISPROVED** |
| F-A-16 | reachability of the `expectedOrderTotal` clamp divergence | — | LATENT |
| F-A-17 | the COGS read returns many rows per order and was undefended | P2 | ✅ FIXED |
| F-A-18 | the shared e2e fake ignored `range()` — could not model paging at all | P2 | ✅ FIXED |
| F-A-19 | `readAllRows` stops on a short page — safe only while max-rows is exactly 1000 | P2 | **OPEN — cross-block (C)** |
| F-A-20 | the two database-backed suites shared one database | P2 | ✅ FIXED |
| F-A-21 | the row-caps suite carried its own hand-copy of the revenue SQL | P2 | ✅ FIXED |

### Block F-B — Financial reporting (branch `8jxi9v`)

| id | title | sev | status |
|---|---|---|---|
| F-B-01 | three surfaces labelled "paid orders" report three different numbers | P1 | ✅ FIXED (repo); 1 migration awaiting owner |
| F-B-02 | the fourth copy of the total formula HAS drifted, by exactly one cent | P3 | DOCUMENTED + hardened; **one latent trap fixed** |
| F-B-03 | sales tax: partial refund vanished; full refund produced a negative liability | P1 | ✅ FIXED |
| F-B-04 | the customer's invoice does not add up, on three real orders today | P2 | ✅ FIXED |
| F-B-05 | two money reads could show part of the store and say nothing | P1 | ✅ FIXED |

### Block G+H — Browser (branch `egmzo3`)

| id | title | sev | status |
|---|---|---|---|
| G-01 | **every ambassador commission accrual fails, silently** | **P0** | **OPEN** — 1-line fix, cross-block |
| G-02 | refunded/cancelled orders never return stock to the shelf | P1 | **OPEN** — needs a migration |
| G-03 | an order and its stock hold are written before the payment session exists | P2 | **OPEN** |
| G-04 | `adjust_inventory_on_sale` does not exist in production | P2 latent | **OPEN** (this is I-12, downgraded — §1.5) |
| G-05 | sales never appear in the inventory ledger | P3 | **OPEN** |
| H-01 | the runbook's mock-payment setup is not achievable | process | **OPEN** — runbook fix |

### Block I — Admin + security (branch `6fogsm`)

| id | title | sev | status |
|---|---|---|---|
| I-01 | email provider secrets plaintext in `admin_audit_logs`, rendered by the viewer | P0 | ✅ read boundary FIXED; **rotation + historical rows owed** |
| I-02 | capability-gate gap — narrower than first filed; money path is dead code | P3/P1 latent | **CORRECTED**, owner decision |
| I-03 | public rate limits keyed on a client-controlled header (+I-03b) | P1 | ✅ FIXED |
| I-04 | `/api/ads/purchase-event/[orderId]` had no sweep protection, writes on GET | P3 | **CORRECTED** + FIXED |
| I-05 | product image upload trusts client MIME + extension (+I-05b PASS) | P1 | ✅ FIXED |
| I-06 | product-image route advertises GIF, the bucket rejects it | P3 | **OPEN — owner decision** |
| I-07 | `create_partner_invite` was an unauthenticated RLS-bypassing write | **P0** | ✅ **REMEDIATED IN PRODUCTION & VERIFIED** |
| I-08 | four of eight CSV escapers allow formula injection | P1 | ✅ FIXED |
| I-09 | four anonymous routes echo raw internal errors | P3 | ✅ FIXED |
| I-10 | admin login leaked username existence through scrypt timing | P3 | ✅ FIXED |
| I-11 | the RPC lockdown is point-in-time; the mechanism that re-opened it is still armed | P1 | **OPEN — owner** |
| I-12 | `adjust_inventory_on_sale` missing → "paid orders never decrement stock" | filed P0 | **see §1.5 — DISPROVED as filed** |

### Block J — Cross-system collisions (branch `8xz6fb`)

45 pairs graded: **6 PROVEN · 12 PARTIALLY PROVEN · 9 UNTESTED · 5 N/A · 13 PENDING**.

| id | title | verdict |
|---|---|---|
| J-01 | carrier webhook replay rewrites finalised profit | PROVEN (= D-02) |
| J-02 | an ordinary Save disarms oversell protection | PROVEN (= D-04) |
| J-03 | the replacement order nobody's rules apply to | PARTIALLY PROVEN — **OPEN** |
| J-04 | one schema drift disables the duplicate-charge guard and blanks the tax trail | PROVEN — ✅ FIXED |
| J-05 | maintenance mode silently stops thirteen background jobs | PARTIALLY PROVEN — **OPEN** (= K-14) |
| J-06 | is the free Buy-3-Get-1 unit reserved? | UNTESTED |
| J-07 | five orders written without the guard columns, one PAID | real, **not** J-04 firing |
| J-08 | the NULL `order_number` row: safest cleanup is to leave it | recommendation |
| J-09 | the same fallback defect is still live in the replacement path | **OPEN** |

### Block K — Timezone / money / dead code / config / legal / degraded / jobs (branch `r8fpix`)

**The brief said "Block K's 16 findings — none has been fixed." Both halves are wrong.**
Block K filed **26** numbered findings and **fixed seven of them**, including K‑16.

| id | title | sev | status as filed |
|---|---|---|---|
| K-01 | cart-recovery emails state coupon expiry in UTC | P2 | ✅ FIXED (with K-05) |
| K-02 | both cart-recovery templates hardcode "5% off" while it is admin-configurable | P2 | **OPEN** |
| K-03 | membership renewal double-charge guard keyed to UTC date; post-charge write unchecked | P1 | **OPEN** |
| K-04 | affiliate link records IP/UA/campaign + 30d id before consent, against 3 published promises | P1 | **OPEN** |
| K-05 | 72h "last chance" email ships a dead coupon, prints `SEE PREVIOUS EMAIL` | P1 | ✅ FIXED |
| K-06 | ten numeric config readers, four hand-copied guards, the unguarded one controls coupon money | P2 | **OPEN** |
| K-07 | "one skip per paid period" allows two skips, in the reminder window | P1 | ✅ FIXED |
| K-08 | birthday bonus decided in UTC | P2 | **OPEN** |
| K-09 | store credit granted/spent on UTC calendar months | P2 | **OPEN** |
| K-10 | offers bar says "Ends tonight" for a coupon expiring that morning, and one a year away | P3 | **OPEN** |
| K-11 | `dollarsToPoints` floors a float — 4.6% of redemptions debit one point less | P2 | **OPEN** |
| K-12 | store credit decided at quote time, debited at settlement time | P1 | **OPEN** |
| K-13 | the "15-minute" inventory hold is up to 45 minutes; every failure reports success | P1 | **OPEN** |
| K-14 | maintenance mode 503s the whole cron sweep and one-click unsubscribe | P1 | **OPEN** |
| K-15 | rate limiting is read-then-write with no claim and fails open silently | P1 | **OPEN** |
| K-16 | three live production ad pixel IDs hardcoded as env fallbacks, no `VERCEL_ENV` guard | P1 | ✅ **FIXED** |
| K-17 | cancelling a paid order permanently destroys its stock | P1 | ✅ FIXED |
| K-18 | four compliance attestations collected, none durably recorded on the card lane | P1 | **OPEN — needs 3 columns** |
| K-19 | every call to the payment processor has no timeout | P1 | **OPEN** |
| K-20 | four tables written and never read; two double the visitor data retained | P2 | **OPEN** |
| K-21 | homepage hardcodes "99%"; checkout makes a different fulfilment promise | P1 | ✅ FIXED |
| K-22 | a coupon that loses the discount competition is still redeemed | P2 | **OPEN** |
| K-23 | email retry sweep has neither duplicate-send guard the codebase already uses | P1 | **OPEN** |
| K-25 | shipping protection was pre-ticked, against the store's own Shipping Policy | P1 | ✅ FIXED |
| K-26 | sales-tax "Taxable Sales" omits the shipping that was taxed | P2 | **OPEN — cross-block F** |
| K-27 | every partially-refunded order is dropped from the sales-tax report | P2 | **OPEN — cross-block F** |

Plus 16 unnumbered closing-sweep items (sweep bounds, legal/policy, dead code, config)
and 10 explicitly **DISPROVEN** leads recorded so they are not resurrected.

## 1.5 I-12 — the brief's stated P0 was already disproved by another block

The brief instructs Block M to treat `I-12` (`adjust_inventory_on_sale` missing →
paid orders never decrement stock) as *"the single most serious open item in the
entire audit"*, and to verify it against production.

**Block G+H already tested it, and refuted it.** From `BLOCK-GH.md`:

> **"Missing `adjust_inventory_on_sale` means paid orders never decrement stock"**
> — disproved by dropping the function and running a real purchase; stock moved
> anyway via `finalize_inventory_for_order`. Downgraded to **G-04**.

Both blocks are right about the *fact* (the function is absent in production) and
Block I was wrong about the *consequence*. `decrementInventoryForOrder` is a
**fallback**; the paid path's stock movement is done by
`finalize_inventory_for_order`, which production does have.

Block I could not have known this — it had no browser and no harness. This is
exactly the class of error the brief predicted ("Two findings in this audit have
already been disproved… Expect more.").

**Block M re-verifies this independently against production in Phase 3** rather
than accepting either block's word. Recorded here so the arithmetic is honest:
`I-12` and `G-04` are **one finding, not two**.

## 1.6 The three worklists

### WORKLIST-1 — OPEN, fix already written but not applied

| id | what is written | where it must land |
|---|---|---|
| G-01 | one-line: `payment_status: "pending"` → `"paid"` on the accrual insert | `payment-webhook.ts:694` |
| G-02 | `alter table orders add column inventory_restocked_at timestamptz` | migration + repo SQL |
| C-01 | 4 RED tests already committed; goes green when `updatePartnerStatus` is right | A+B's `partner-portal.ts` — **already fixed on `754dol`**, verify after merge |
| C-02 | 3 RED tests already committed; needs the sweep to close the send-once slot | `email/order-email-sweep.ts` + index |
| K-06 | hoist four hand-copied `num()` guards into one `controlNumber()` | `admin-control.ts` (10 call sites) |
| K-14 | add `/api/cron`, `/api/unsubscribe`, `/api/coa`, `/api/health`, `/api/veyra` to the bypass list | `middleware.ts:65-82` |
| K-19 | `signal: AbortSignal.timeout(10_000)` — 2 lines | `email/providers/resend.ts:25`, `sendgrid.ts:29` |
| K-13 | `throw` instead of swallowing the RPC error | `inventory-reservation.ts:185-196` |
| K-26/K-27 | persist `resolveSalesTax`'s own `taxableBase`; add `partially_refunded` to the report | `admin-tax-report.ts` — **may already be done by F-A-05/F-A-07**, verify after merge |
| F-A-13 | do not blank `tax_state`/`tax_rate_percent` in the degraded insert, or alert | `quote-order.ts` |
| F-A-19 | bounded paging helper exists (`supabase-page-bounded`); switch the three callers | `admin-email.ts`, `email/audience.ts`, `marketing-broadcast.ts` |
| I-11 | `alter default privileges … revoke execute … from anon, authenticated` | production DDL — **owner** |
| K-18 | persist the card lane's compliance acknowledgement | needs 3 new `orders` columns — **owner** |

### WORKLIST-2 — OPEN, no fix yet

`C-03` · `C-04` · `C-05` · `C-07` · `C-08` · `C-09` · `C-10` · `C-11` · `C-12` ·
`C-13` · `C-14` · `C-15` · `C-16` · `D-06` · `G-03` · `G-05` · `H-01` · `I-06` ·
`J-03` · `J-09` · `K-02` · `K-03` · `K-04` · `K-08` · `K-09` · `K-10` · `K-11` ·
`K-12` · `K-15` · `K-20` · `K-22` · `K-23` · `F-A-14` · `F-006` · `F-008` · `F-012` · `F-015`

### WORKLIST-3 — CROSS-BLOCK notes, by the file whose owner blocked them

| file | blocked finding(s) | owning block |
|---|---|---|
| `src/lib/payment-webhook.ts` | G-01, C-05, K-12 | A+B |
| `src/lib/partner-portal.ts` | C-01, C-16, K-01, K-20, F-A cross-note (`getAdminOperationsSummary`) | A+B |
| `src/app/r/[code]/route.ts` | K-04, K-20 | A+B |
| `src/lib/email/templates.ts` | K-01, K-02, K-05 | C |
| `src/lib/email/providers/*.ts` | K-19 | C |
| `src/lib/supabase-page.ts` callers | F-A-19 | C |
| `src/lib/inventory-reservation.ts` | K-13 | D |
| `src/lib/sql/inventory-reservations.sql` | K-13, K-17 | D |
| `src/lib/inventory-fulfillment.ts` | I-12 / G-04 | D |
| `src/lib/admin-tax-report.ts` | K-26, K-27, K-11 | F |
| `src/lib/quote-order.ts` | F-A-08, F-A-13, K-18, G-03 | shared |
| `src/app/api/admin/orders/[orderId]/route.ts` | C-03, C-11, K-17, F-A-14 | I |
| `src/app/api/admin/cart-recovery/settings/route.ts` | K-06 | I |
| `middleware.ts` | K-14 | I |
| the three IP resolvers | K-15 (+I-03) | I |
| `src/lib/admin-control.ts` | K-06 | **M** |
| `vitest.config.ts` + `website/scratchpad/` | the gate baseline | **M** |
| `src/lib/order-communications.ts` | C-12 | C/I |
| `src/lib/marketing-broadcast.ts` | C-09 | C |
| `src/lib/campaign-sender.ts` | C-13 | C |
| `src/lib/membership-billing.ts` | C-14 | D/K |
| `src/lib/inventory-reservation-model.ts` | E-B cross-note | D |

## 1.7 Merge-conflict surface, predicted before merging

Files touched by more than one branch, excluding the shared base:

| file | branches | expected |
|---|---|---|
| `src/lib/admin-profit.ts` | F-A + F-B | **hard conflict — both rewrote it** |
| `src/lib/admin-reconciliation.ts` | F-A + F-B | **hard conflict** |
| `src/lib/admin-revenue.ts` | F-A + F-B | **hard conflict** |
| `src/lib/admin-tax-report.ts` | F-A + F-B | **hard conflict** |
| `src/lib/admin-profit-at-scale.test.ts` | F-A + F-B | **hard conflict** |
| `src/lib/ledger.ts` | F-A + F-B | conflict |
| `src/lib/e2e/fake-db.ts` | F-A + F-B | conflict |
| `src/lib/sql/admin-dashboard-rollups.sql` | F-A + F-B | conflict |
| `src/lib/cart-recovery.ts` | C + K | conflict |
| `src/lib/membership-billing.ts` | D + K | conflict |
| `src/lib/admin-products.ts` | D + I | **non-overlapping hunks** — anchors `editableDoseValues` (D) and `sniffImageType` (I) must BOTH survive |
| `vitest.setup.ts` | E-A + E-B | conflict |
| `website/.gitignore` | G+H + K | trivial |
| `scripts/pgrst-shim.mjs` | base + G+H | identical |
| `src/lib/partner-portal.ts` | A+B (267 lines) over base (38) | A+B supersedes |

**Rule for every one of these: read both sides and understand what each was
fixing. Two blocks editing one file were fixing different bugs; "newest wins"
deletes one of them.**

---
