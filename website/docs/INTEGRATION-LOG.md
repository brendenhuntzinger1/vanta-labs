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

# PHASE 2 — MERGE

Baseline before any merge, at `9aea901` + this file:
**201 files / 3566 tests / 0 skipped / 0 failing.**

| # | merged | conflicts | tests after | notes |
|---|---|---|---|---|
| 1 | `audit-superpowers-playwright-extension-c2oyhm` (audit base) | none | 203 files / **3579** (7 skipped) | matches the ledger's recorded Phase 19 baseline exactly |
| 2 | `vanta-labs-audit-resume-754dol` (A+B) | none | 207 files / **3607** (29 skipped) | skips are the four database-gated suites |
| 3 | `browser-testing-blocks-gh-egmzo3` (G+H) | none | — | scripts + harness SQL only |
| 4 | `block-ab-audit-6fogsm` (I) | none | 217 files / **3700** (29 skipped) | |
| 5 | `block-ab-audit-8xz6fb` (D+J) | none | — | **`admin-products.ts` verified: both anchors present** — `editableDoseValues` ×4 (D) and `sniffImageType` ×2 (I) |
| 6 | `block-ab-audit-zuuyuz` (C + E-A) | none mechanically; **2 semantic** | 227 files / **3712** (29 skipped), 3 failing | see below |

## 2.1 The merge conflicts that git did not report

Both Block F branches, Block C and Block E-A wrote their fakes against
`partner-portal.ts` **as it was before Block A+B landed**. A+B then hardened three
call sites. Git merged the files cleanly because they are different files — the
collision is behavioural, and only the test run finds it.

This is the exact failure mode the brief warns about: *a clean-looking merge is
not proof nothing was lost.* Nothing was lost here — but three suites started
failing for reasons unrelated to the defects they were written to catch, and a
careless resolution would have "fixed" them by weakening the assertions.

### 2.1.a `payout-authority-guards.test.ts` — 3 failures, product code CORRECT

`autoApproveEligibleCommissions` now requires **both** `ambassadors.status` and
`partners.status` to be `approved` (A+B's **F-019**), and claims its rows with
`.eq("payment_status","pending").select(...)` (A+B's **F-016**). Block E-A's fake
seeded only `ambassadors` and its `update` chain ended at `.in()`.

**Resolution: the fixture was wrong, not the code.** The fake now
- serves a `partners` table alongside `ambassadors`;
- models the **claim-guarded** update — `.in().eq().select()` returns only rows
  that still hold the guarded value.

Three new tests were added, each of which the old fake could not have expressed:

| new test | proves |
|---|---|
| refuses a ripe commission when only `ambassadors` says approved | F-019 |
| refuses a ripe commission when only `partners` says approved | F-019 |
| does not re-approve a commission reversed between the read and the write | **F-016** |

**Mutation controls (run, recorded):**

| mutation | result |
|---|---|
| delete the hold-period comparison (**M07**) | **3 failures** — matches Block E-A's recorded control exactly |
| drop the `partners` half of the two-table gate | **1 failure** |
| drop `.eq("payment_status","pending")` from the approval update | **1 failure** — *this survived before the new test; it is the gap the merge exposed* |

`12 passed (12)`.

### 2.1.b `approval-email-commission-rate.test.ts` — 6 failures, and **C-01 is CLOSED**

Block C committed these RED as evidence for **historical defect #3**, stating the
fix belonged to A+B. **A+B had already written it** (F-017: read the rate back
from the authoritative `ambassadors` row *after* the write; F-018: an update
matching zero rows is not success). The two branches never saw each other.

Block C's fake swallowed writes and ended its update chain at `.eq()`, so the
tests crashed on `.select is not a function` before they could observe the fix.

**Resolution: the fixture now applies writes** and supports `.eq().select()`, so
the post-write read-back can be observed at all. **No assertion was changed.**
All six turn green — which is precisely the acceptance criterion Block C set.

One new negative control was added for F-018: approving someone with no
`ambassadors` row must reject and send nothing.

**Mutation controls (run, recorded):**

| mutation | result |
|---|---|
| read the rate from the pre-write `partners` mirror (**the original defect #3**) | **4 failures** |
| drop the zero-rows-is-not-success guard (F-018) | **1 failure** |
| re-send the approval email on a non-transition | **1 failure** |

`7 passed (7)`. **Historical defect #3 is closed, with an independent test from a
block that did not write the fix.**

### 2.1.c `order-email-sweep-duplicate.test.ts` — 3 failures, GENUINE, carried to Phase 4

C-02 is a real unfixed defect: the retry sweep delivers a receipt without closing
the send-once slot, so a later caller can claim the released slot and send the
customer a second one. These stay RED until Phase 4 fixes them.

**Running total after merge 6: 227 files / 3712 tests, 3 failing — all three are
C-02, all three deliberate.**

| 7 | `audit-parallel-assignments-block-k-r8fpix` (K) | **2 files** (`cart-recovery.ts`, `.gitignore`) | 235 files / **3892** (29 skipped), 3 failing | see §2.2 |
| 8 | `block-ab-audit-o62bop` (F-A) | none | 243 files / **3937** (44 skipped), 3 failing | renamed `BLOCK-F.md` → `BLOCK-F-A.md` first, so merge 9 could not collide on the path |
| 9 | `audit-blocks-f-e-8jxi9v` (F-B + E-B) | **8 files** | 249 files / **4032** (65 skipped), 3 failing | see §2.3 |

## 2.2 Block C × Block K — `cart-recovery.ts`

Two blocks rewrote the abandoned-cart sweep, for different reasons. Taking either
side loses a real fix.

| | Block C (C-06) | Block K (K-05, K-01) |
|---|---|---|
| defect | minting the coupon **before** claiming the stage let a failed send re-mint on every 30-min sweep — 2,994 passes, 335 live coupons in production | the t72h email printed the literal string `SEE PREVIOUS EMAIL` and an expiry no row held; and re-offering the t24h code is not enough, because under the shipped defaults that code is already dead when t72h fires |
| fix | claim the `(cart, stage)` slot first, mint behind it | `resolveLastChanceCoupon` — re-offer only while still live, mint fresh otherwise; format expiries through `formatDisplayDate` |

**Resolution: both.** The sweep claims first, and resolves the coupon *behind the
claim* through Block K's resolver. `couponFromStage` was deleted — it read the same
reservation without checking liveness, which is the defect K-05 names, and keeping
two readers of one reservation is the duplicate-implementation shape this audit
exists to remove.

**Mutation controls (run, recorded):**

| mutation | result |
|---|---|
| let a failed send re-arm the stage (undo C-06) | **5 failures** |
| drop the liveness check, re-offer a dead coupon (undo K-05) | **1 failure** |
| format the expiry in the ambient zone again (undo K-01) | **1 failure** |
| restore the `SEE PREVIOUS EMAIL` placeholder | **7 failures** |

Two fixtures had to start applying writes: `cart-recovery-last-chance.test.ts`
swallowed `update()` and `delete()`, so `coupon_id` never landed on the
reservation and the suite would have gone on passing while the merged code minted
a second coupon for a cart that already had a live one.

`.gitignore`: both sides kept, with a note that `.gitignore` does **not** keep
probes out of vitest — that needs `vitest.config.ts`, which is §7.

## 2.3 Block F-A × Block F-B — the same five modules, twice

Both sessions were assigned "Block F — financial reporting" and both rewrote
`admin-profit.ts`, `admin-revenue.ts`, `admin-reconciliation.ts`,
`admin-tax-report.ts`, `ledger.ts`, `admin-dashboard-rollups.sql` and
`admin-profit-at-scale.test.ts`. Several of their findings are the same defect
found twice. Every conflict was resolved by taking **both** corrections where they
were different, and **one implementation** where they were the same rule.

| file | F-A had | F-B had | kept |
|---|---|---|---|
| `ledger.ts` | `REVENUE_ORDER_STATUSES` — a partial refund keeps its retained revenue | `NON_SALE_ORDER_TYPES` / `isSaleOrder` — a reship is not a sale | **both**; they answer different questions |
| `admin-revenue.ts` | paged to exhaustion via `readAllRowsBounded`; widened to revenue statuses | excluded reships from the JS fallback | **both**, in one query |
| `admin-dashboard-rollups.sql` | `partially_refunded` added | `order_type <> 'replacement'` added | **both**, in both functions |
| `admin-profit.ts` | `readAllRowsBounded` (advances by rows received; probes past the ceiling) | local `readOrdersPaged` (fixed stride, **breaks on a short page**, swallows query errors) + a COUNT cross-check + `truncated` on the 30-day window | **`readAllRowsBounded`**, plus F-B's `truncated` signal and `isSaleOrder`. The local pager was deleted — its short-page break is exactly the latent defect `F-A-19` names |
| `admin-reconciliation.ts` | `readAllRowsBounded` | local pager + a COUNT cross-check that raises `scan_truncated` | **F-A's read, F-B's COUNT check** — the COUNT was outside the conflict and survives |
| `admin-tax-report.ts` | paged to exhaustion; `refundedTaxFor` (exported, mirrored by `admin-profit`) | 20-page loop; `refundedProportionOf` (local); per-row `netTax` | **F-A's paging, F-B's per-row `netTax`, one refund rule** (`refundedTaxFor`). `refundedProportionOf` deleted: two functions answering one question about one refund is how a filing report and a profit report end up disagreeing |
| `vitest.setup.ts` | **deleted nine of eleven global stubs** after measuring each by removal | kept all eleven and catalogued where each module is really exercised | **the deletions, plus the catalogue as a comment.** A stub nothing needs is pure invisible coverage loss; the catalogue is the map of which modules had no behavioural coverage at all |
| `admin-profit-at-scale.test.ts` | matches `readAllRowsBounded`; has the COGS-cap test (`F-A-17`) | matches the local pager; asserts the COUNT | **F-A's**, since it matches the implementation kept |

`refunded` on a tax row now means **any** refund, partial or full. F-A had kept it
full-only "for the existing CSV/table columns"; no surface reads it — the CSV and
the revenue page both read the `byState` summaries — so the honest meaning wins.

### Fallout from deleting the global stubs, and why it was worth it

Two Block F-B/E-B suites were written against a setup that stubbed eleven modules
for every file in the repo. With the stubs gone they broke, which is the point:

- **`reconciliation-drift.test.ts`** (18 tests) hit the real `supabase-server` and
  threw on a missing env var. It now applies `supabaseServerModule()` locally —
  visible in the suite that needs it, per E-A's rule. 18 passing.
- **`membership-signup-behaviour.test.ts`** mocked `@/lib/veyra-membership`
  without `changeVeyraMembershipPlan`, which **Block D added for D-05**. The mock
  now has it, and the tier-change test asserts D-05's actual guarantee: the new
  price is pushed to the processor, not just written locally.
  **Mutation control: removing the reprice call breaks 4 tests.**

**After merge 9: 249 files / 4032 tests, 3 failing — all three C-02, all three
deliberate. `tsc --noEmit` clean.**

## 2.4 Arithmetic re-asserted after the merge

All eleven findings files are present and distinctly named:
`BLOCK-C`, `BLOCK-D`, `BLOCK-E-A`, `BLOCK-E-B`, `BLOCK-F-A`, `BLOCK-F-B`,
`BLOCK-F-PRODUCTION-CHANGES`, `BLOCK-GH`, `BLOCK-I`, `BLOCK-J`, `BLOCK-K`, plus the
ledger. **131 numbered findings, 2 sub-findings, 16 unnumbered — unchanged.**
Nothing was eaten.

---

# PHASE 3 — I-12, VERIFIED INDEPENDENTLY AGAINST PRODUCTION

Read-only, against `mlpimwgkwuqpsvsrlpqv`. Three separate facts, and they do not
say the same thing.

## 3.1 The function really is missing — CONFIRMED

```sql
select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where p.proname ilike '%inventory%' or p.proname ilike '%adjust%' or p.proname ilike '%stock%';
```

```
public | finalize_inventory_for_order(p_order_id text)
public | release_inventory_for_order(p_order_id text)
public | reserve_inventory(p_slug text, p_variant_id text, p_order_id text, p_quantity integer, p_expires_at timestamptz)
```

**No `adjust_inventory_on_sale`, in any schema.** 22 functions exist in `public`;
it is not one of them. Block I and Block G+H are both right about this.

## 3.2 Its stated consequence is **DISPROVED**

> *"paid orders never decrement stock"*

They do. `finalize_inventory_for_order` **exists in production** and is what moves
the stock. Its body, read from production's own catalog:

```sql
for r in select id, slug, variant_id, quantity from public.inventory_reservations
   where order_id = p_order_id and status = 'active' for update loop
  update public.product_doses
     set inventory_quantity = greatest(0, inventory_quantity - r.quantity),
         reserved_quantity  = greatest(0, reserved_quantity  - r.quantity),
         stock_status = case when inventory_quantity - r.quantity <= 0 and track_inventory
                             then 'Out of Stock' else stock_status end
   where id::text = r.variant_id;
  …
  update public.inventory_reservations set status = 'finalized' where id = r.id;
```

Both paid paths call it first and reach the missing function only as a fallback
(`payment-webhook.ts:1136` and `:1646`):

```ts
const fin = await finalizeInventoryForOrder(orderId);
if (fin.degraded || fin.finalized === 0) {
  await decrementInventoryForOrder(...);   // ← the one that calls the missing RPC
}
```

Block G+H proved the same thing empirically — it dropped the function from the
harness to match production and ran a real purchase; stock moved 23 → 21 anyway.
Block I had no harness and could not have known.

**`I-12` and `G-04` are ONE finding, and its severity is `P2 latent`, not `P0`.**
Recorded as such. The brief's instruction to treat it as "the single most serious
open item in the entire audit" rests on Block I's stated consequence, and that
consequence does not hold.

## 3.3 What IS real, and is worse than the fallback

Three things remain true and one of them is a genuine launch blocker.

### G-02 — refunds and cancellations never return stock. **CONFIRMED P1.**

```sql
select column_name from information_schema.columns
where table_schema='public' and table_name='orders'
  and column_name in ('inventory_restocked_at','paid_side_effects_at');
```

```
paid_side_effects_at        ← present
(inventory_restocked_at)    ← ABSENT
```

`restockInventoryForOrder` is gated behind `claimInventoryRestock`, which flips
`orders.inventory_restocked_at` from NULL. The column does not exist, so the claim
errors `42703` and — by its own documented fail-safe — returns false, and the
caller does not restock. **The safe branch is the only branch that ever runs.**

Production has `inventory.tracking_enabled = true`, so stored quantities really do
gate sales. Every refund or cancellation permanently destroys its units. Products
will read "Out of Stock" while sitting on the shelf, and the only trace is a log
line. This is the P0-shaped item in this area, and it is not the one the brief
named.

### G-04 — the fallback path is inert

When `finalize` finds no active hold (`finalized === 0`): an expired reservation,
an untracked item, a pre-migration order, or a replacement order. In those cases
the fallback fires, calls a function that does not exist, and the error is caught
and logged. Silent, bounded, real.

### The trap in the obvious fix

Deploying `adjust_inventory_on_sale` on its own is **not** safe to do casually.
`finalized === 0` is also what a *replayed* webhook sees once the reservation is
already `finalized`. The `paid_side_effects_at` claim
(`payment-webhook.ts:1449-1461`) is what stops a replay reaching this code at all —
so the missing function is currently the *second* line of defence, and the first
one must be verified live before the second is restored. It is, and it is in
production, which is why deploying the function is safe **in that order** and only
in that order. Recorded in `DEPLOYMENT-ORDER.md`.

## 3.4 The seven live migrations

```
20260825003037  rpc_execute_lockdown
20260825204855  referral_code_returns_customer_discount
20260825214916  partner_application_atomic_creation
20260825215051  affiliate_balances_server_side_aggregate
20260825231628  partner_application_adopts_pre_added_ambassador
20260826002258  partner_invite_atomic_and_convergent
20260826014217  revoke_anon_create_partner_invite
```

22 functions in `public`. Reconciled against the repo in Phase 5.

## 3.5 Verdict on I-12

| | |
|---|---|
| **as filed** (P0 — paid orders never decrement stock) | **DISPROVED** |
| **the schema gap** (`adjust_inventory_on_sale` absent) | **CONFIRMED**, P2 latent, = `G-04` |
| **the real P1 in this area** | **`G-02`** — no `inventory_restocked_at`, so nothing is ever restocked |

Three findings in this audit have now been disproved after being filed as
defects: `F-005`, `F-007`, and `I-12`.

---

# PHASE 4 — REPAIRS

## 4.0 A local Postgres, and six tests nobody had ever run

The database-gated suites were skipping (65 tests). A local Postgres 16 was
started for the session, and they ran for the first time **on the merged tree**:

```
initdb -D /tmp/vantapg -A trust -U postgres     # as an unprivileged user
pg_ctl -D /tmp/vantapg -o '-p 55432 -k /tmp' start
VANTA_TEST_DATABASE_URL=postgres://postgres@localhost:55432/postgres npx vitest run
```

**Six failed.** All six were in the Block F merge area, and none of them could
have been seen without a database. This is precisely why a skipped suite that
reports success is dangerous.

### M-02 — the reconciliation screen died on a missing optional column

`getReconciliationFlags` carries a deliberate degradation and states its reason:

> *"Reconciliation reporting an error is worse than reconciliation reporting
> slightly softer results, and this is the screen an operator opens when they
> already suspect something is wrong."*

It degraded on `shipping_protection_fee` alone. **Block F-B added `handling_fee`
to the same formula** — it is the fifth term of the charged total — **but not to
the fallback.** An environment with one column and not the other threw, which is
the exact opposite of the promise. Latent in production (which has both), live
for anyone on an older schema, and it only surfaced when two branches met and a
DB-backed suite ran.

**Fix:** the read now drops optional columns **one at a time**, preferring the
column the error actually names, and only for errors that look like a schema gap.

New suite `reconciliation-column-degrade.test.ts` — 6 tests, always-on (no DB).

| mutation | result |
|---|---|
| put `handling_fee` back among the mandatory columns (the pre-fix state) | **2 failures** |
| drop the newest optional column instead of the one the error names | **1 failure** |
| soften on ANY error rather than only a schema gap | **1 failure** *(survived until a hard-error control was added — recorded, because the first version of this suite could not tell a permission failure from a missing column)* |

### The four truncation assertions — STRENGTHENED, not weakened

Four tests asserted that a server-side row cap must raise `truncated` /
`scan_truncated`. They passed on Block F-B's branch because its local pager
advanced by a fixed stride and stopped on the first short page — a cap really did
cut the scan short, so announcing it was the best available outcome.

The merged reader (`readAllRowsBounded`) advances by the rows it actually
received, so a cap costs round trips instead of coverage. **Measured, not
assumed** — a probe was added to the failing tests before touching them:

```
PROBE maxRows=40 over 100 orders -> flags: []
PROBE maxRows=500 over 1500 orders -> {"orders":1500,"truncated":false}
```

The requirement is *"the operator must not be shown a smaller number as if it
were the whole story."* There are two ways to satisfy it and **returning the
whole story is the better one.** The assertions now require completeness. The
ceiling case — where the application's own bound, not the server, ends the read —
remains asserted in `supabase-page-bounded.test.ts`.

**Mutation control:** making the pager stop on a short page again (Block F-B's
behaviour) breaks **8 tests** across three files.

### The two order-count expectations

`financial-reporting-consistency` expected 7 revenue orders and got 6;
`financial-reporting-row-caps` expected 20,958 and got 20,937. Both differences
are **exactly the `$0` reships** — 1 and 21 respectively. That is Block F-B's
`NON_SALE_ORDER_TYPES` exclusion, merged into the SQL rollup and the JS fallback,
working correctly. The fixtures predate it; their expectations now derive the
sale set rather than restating a total, and both assert that excluding a reship
moves the **count** and not the **money**.

`handling_fee` was also added to two fixtures' schemas, because production has it
and a fixture that does not model production is how M-02 hid.

## 4.1 M-01 — the ambassador commission P0, and why the proposed fix was wrong

**Block G+H's `G-01` is real and is the most valuable defect in this audit: no
paid referral order has ever written a commission, and the failure is silent.**
Its stated root cause and its proposed fix were both incomplete.

### Reproduced against production — rolled-back `DO` block, nothing persisted

Four arms, running the payload `payment-webhook.ts:684-745` actually sends:

```
ARM1 the payload as written today      -> 23502  original_subtotal not-null
ARM2 same payload, payment_status=paid -> 23502  original_subtotal not-null
ARM3 + original_subtotal + customer_discount -> INSERTED
ARM4 then advance to approved_for_payout     -> 23514  check constraint
```

**Three defects stacked on one insert:**

1. `original_subtotal` and `customer_discount` are **NOT NULL in production with
   no default**, and the application never sent either. The insert dies here —
   one step **before** the CHECK that Block G+H reported.
2. `payment_status: "pending"` is refused by
   `referral_orders_payment_status_check`, which admits only
   `paid | refunded | partially_refunded`.
3. **The lifecycle cannot advance even after a successful insert.**
   `approved_for_payout` is refused by the same CHECK.

**ARM2 is the important one: Block G+H's one-line fix does not work.** And had it
worked, it would have been worse than the bug — a row accrued straight to `'paid'`
skips the hold period, is invisible to `autoApproveEligibleCommissions` (which
selects `pending`) and to `markCommissionsPaid` (which selects
`approved_for_payout`). Money state wrong instead of money missing.

### Which side is authoritative

All three repository definitions of this table — `deploy-run-once.sql`,
`orders-schema.sql`, `partner-system-repair.sql` — declare
`payment_status text not null default 'pending'` with **no CHECK**, beside
`approved_for_payout_at`, `commission_paid_at` and `reversed_at`. Those three
timestamps only make sense if this column is the **commission lifecycle**.

The narrow CHECK appears in **no repository file**. It is production-only drift,
the same class as ledger `F-011`. So the constraint moves and the code does not.

### The fix, both halves

**Code** (`payment-webhook.ts`) — send the two missing columns, derived from
values already in hand:

```ts
const customerDiscountAmount = roundMoney(Math.max(0, qualifyingSubtotal - commissionableSubtotal));
…
original_subtotal: qualifyingSubtotal,
customer_discount: customerDiscountAmount,
```

On Block G+H's real browser order that is `131.10 − 117.30 = 13.80` — exactly the
`Ambassador code EXPLICIT15 −$13.80` line the shopper saw.

**Schema** — `src/lib/sql/referral-orders-commission-lifecycle.sql`, with
`ROLLBACK-referral-orders-commission-lifecycle.sql` beside it. **Staged, not
applied.** See `DEPLOYMENT-ORDER.md`.

### The test that was passing because its fake was more permissive than the database

`ambassador-commission-lifecycle.test.ts` drives the **real** webhook and already
modelled production's UNIQUE keys — its own header argues at length for exactly
that. It did **not** model the NOT NULL columns or the CHECK, so all 20 of its
commission tests were green while production refused every accrual.

The double now enforces production's real constraints, quoted verbatim from its
catalog. **Adding that enforcement turned 12 of 20 tests RED for the right
reason**, and the code fix turns them green. Three new assertions were added.

| mutation | result |
|---|---|
| stop sending `original_subtotal` | **18 failures** |
| stop sending `customer_discount` | **18 failures** |
| accrue straight to `'paid'` (the originally proposed fix) | **1 failure** |
| drop the negative clamp on `customer_discount` | **survived — EQUIVALENT MUTANT, reported as such.** Both call sites derive `commissionableSubtotal = max(0, subtotal − discountAmount)` from the same `subtotal` they pass as `qualifyingSubtotal`, so the clamp is unreachable by construction today. It is kept as defence against a future caller, because the database would refuse a negative. The invariant `original_subtotal >= amount_paid` **is** asserted. |

### The migration, proven on the harness before being staged

Production's `referral_orders` shape was rebuilt verbatim on the harness project
(`snnezhxvssochqpqsjcm`) and the migration run against it inside a rolled-back
block:

```
BEFORE accrual(pending):        23514 rejected          ← the defect, reproduced
AFTER  accrual(pending):        INSERTED
AFTER  advance -> approved_for_payout: OK
AFTER  advance -> paid:                OK
AFTER  advance -> reversed:            OK
AFTER  garbage value:           23514 correctly refused  ← still load-bearing
AFTER  negative discount:       23514 correctly refused  ← other checks intact
ROLLBACK with a pending row:    23514 refused — correct, the owner must decide
```

The rollback **failing** while a live `pending` row exists is deliberate and is
the safe behaviour: reverting would otherwise orphan real accrued commissions,
and what happens to them is the owner's decision, not a migration's.

### Recorded, not fixed

`referral_orders.payout_status` (CHECK `unpaid|paid|void`) exists in production
and **nothing in the application ever reads or writes it.** The lifecycle lives
on `payment_status` instead. Converging the two is a real change to money code
and is a follow-up, not something to smuggle into a constraint fix.

## 4.2 C-02 — the retry sweep that delivered a receipt and left the door open

Block C committed three RED tests and left the decision to Block M:

> *"The owner held this on 2026-08-26… **Block M decides with the full picture.**"*

**Decision: apply it.** The alternative — matching `subject ilike '%<orderNumber>%'`
— is the fragile join `C-08` is a finding *about*. The migration is two nullable
columns and one partial index on a table with **zero rows ever**.

### A defect in the proposal itself

The held proposal declared `pending_emails.order_id **uuid**`.
`order_email_log.order_id` is **text** in production (verified against
`information_schema.columns`), and order ids look like `order-23e40002-…`.

**A uuid column could not hold them.** The migration would have applied cleanly,
the write-back join would have matched nothing, and the duplicate would have
survived a fix everyone believed had landed. Corrected to `text` in
`src/lib/sql/pending-emails-order-link.sql`.

### The fix

- `enqueueFailedEmail(message, error, context?)` takes `{ orderId, kind }` and
  writes them, **degrading to the old insert** if the columns are not there yet.
  So the code is safe to deploy *before* the migration, and the migration is safe
  to apply *before* the code — which is what lets `DEPLOYMENT-ORDER.md` put them
  in either order.
- The sweep reads the link (degrading the same way), sends with
  `idempotencyKey: ${kind}:${orderId}` — the same identity `sendOrderEmailOnce`
  uses, so the provider also sees one email — and on success closes the slot:
  `order_email_log … set status='sent' where order_id=? and kind=? and status='failed'`.
- The `status='failed'` guard is load-bearing: without it a sweep landing while
  another sender holds `'sending'` would flip that live claim to `'sent'`.
- The two `payment-webhook.ts` call sites pass the context. The Shippo one does
  **not**, deliberately — shipping notices hold no `order_email_log` slot, and
  Block C's own spec says context-less rows must behave exactly as before.

| mutation | result |
|---|---|
| sweep stops closing the slot | **2 failures** |
| sweep stops sending an idempotency key | **1 failure** |
| the approval path stops passing the order context | **1 failure** *(survived the first round — nothing asserted the real call site; a behavioural test was added to `manual-payment-double-approve.test.ts`, which drives the real approval path with a failing provider)* |
| write-back stops guarding on `status='failed'` | **1 failure** *(also survived the first round; a live-slot control was added)* |
| enqueue stops writing the order link | **3 failures** |

### One safety invariant deliberately widened, and inverted while widening

`order-communications.test.ts` asserted the retry module writes to exactly one
table — the safety claim shown to the owner in the UI. The sweep now also writes
`order_email_log`, which is email bookkeeping, the same category as
`pending_emails`.

An allowlist that merely grew by one is weaker than it looks, so the assertion
was **inverted**: it now names the FORBIDDEN tables explicitly — orders,
payments, referral_orders, commissions, payouts, products, inventory, coupons,
memberships, shippo events — and keeps the allowlist beside them. The next person
to add a table has to justify it against the danger list, not just extend an array.

---

**After Phase 4's first pass: 250 test files, ALL GREEN, `tsc` clean, lint 0
errors. This is the first time the merged tree has been fully green** — Block C's
three deliberate failures are now closed by their fix rather than by their
assertions being changed.

## 4.3 G-02 + G-04 + K-17 — three findings, one missing pair

Verified against production this session:

```
orders.inventory_restocked_at   ABSENT
adjust_inventory_on_sale        ABSENT   (22 functions in public; not one of them)
```

- **G-02** — `restockInventoryForOrder` is gated by `claimInventoryRestock`,
  which flips a column that is not there. The claim errors `42703` and, by its
  own fail-safe, returns false. **The safe branch is the only branch that ever
  runs.** Inventory tracking is ON in production, so every refund and every
  cancellation permanently destroys its units.
- **G-04** — even a claim that succeeded would move nothing: the delta goes
  through the missing function.
- **K-17** — Block K's fix for *"cancelling a paid order permanently destroys its
  stock"* routes through **both**. **It is inert in production, twice over.**
  Block K had no database and could not have seen it.

One migration closes all three, and none of them closes without it:
`src/lib/sql/inventory-return-path.sql` (+ its rollback).

### The trap in shipping the repository's own copy

`deploy-run-once.sql:941` defines `adjust_inventory_on_sale` moving
`inventory_quantity` **and nothing else**. Fine on the way down; wrong on the way
up — `finalize_inventory_for_order` stamps `stock_status='Out of Stock'` when a
sale empties a line, and nothing would ever stamp it back. **A refunded unit
would return with the count correct and the storefront still refusing to sell
it.** Deploying the repo's copy verbatim would have turned one silent failure
into another, and closed the finding on paper.

The repository already answers this, in the admin receive-stock path
(`inventory-operations.ts:102-108`): *"Move the STATUS with the quantity, or
receiving a shipment does not put the product back on sale… Only the automatic
pair is touched. 'Limited' and 'Reserved' are set deliberately in the product
editor and must survive a stock movement."* The migration applies that same rule,
so the two paths cannot disagree. **This answers Block K's open question**
("does `restockInventoryForOrder` reset `stock_status`?") — it does now.

### Proven on the harness, then regression-tested against the shipped file

Harness (`snnezhxvssochqpqsjcm`), rolled back:

```
restock sold-out(+1):        moved=t qty=1 status=In Stock      ← the fix
sell in-stock(-5):           moved=t qty=0 status=Out of Stock
restock curated(+3):         moved=t qty=3 status=Limited       ← editorial survives
oversell in-stock(-1 at 0):  moved=f qty=0                      ← guard holds
unknown slug:                moved=f
```

`inventory-return-path.test.ts` — 10 tests — executes
**`sql/inventory-return-path.sql` itself**, not a copy, against a real Postgres.
A test that restated the function body would pass while the shipping file said
something else, which is exactly how this function came to exist in the repo and
not in the database.

| mutation | result |
|---|---|
| ship `deploy-run-once.sql`'s version verbatim (quantity only, no status rule) | **2 failures** |
| let the status rule stomp editorial statuses too | **1 failure** |
| drop the never-below-zero guard | **1 failure** |
| never add the claim column | **suite-level failure** — the migration's own partial index refuses to build, reported as `Test Files 1 failed` |

### Not done, deliberately

Historical refunds are **not** replayed. Orders refunded before this runs have
already lost their units and will read `inventory_restocked_at IS NULL`, which is
true. Restoring those counts is a data decision — which orders, and does the
physical shelf agree — not a migration. The query to list them is in the file.

## 4.4 K-14 and K-19 — the two that stop the machinery

### K-14 — maintenance mode 503s the machinery behind the shop front

`pathBypassesMaintenance` did not list five routes that must never be rewritten:

| route | what turning maintenance mode on did to it |
|---|---|
| `/api/cron` | **503'd the entire sweep** — all thirteen jobs, including reservation expiry, payment reconciliation and the email retry queue. Authenticated by `CRON_SECRET`, so nothing human reaches it anyway |
| `/api/unsubscribe` | broke the one-click link in marketing mail **already delivered** |
| `/api/veyra` | dropped processor callbacks — the sibling of `/api/webhooks`, which was already listed |
| `/api/coa` | stopped serving published certificates, a compliance document |
| `/api/health` | removed the only way to tell the site is up |

`maintenance-bypass.test.ts` (17 tests) drives the **real predicate**, lifted out
of `middleware.ts` and evaluated, rather than asserting on its source — so a
rename or a reordering cannot make it pass hollowly. It asserts what must get
through **and** what must still be held back.

| mutation | result |
|---|---|
| remove `/api/cron` | **2 failures** |
| remove `/api/unsubscribe` | **2 failures** |
| `return (true \|\| …)` — a bypass list that is not a list | **7 failures** |

One thing recorded rather than changed: `startsWith("/api/cron")` also passes
`/api/cron-not-a-real-route`. No such route exists, and tightening it to a
segment boundary is a change with no defect behind it. The test says so, and is
where to notice if one is ever added.

### K-19 — the calls that take money had no deadline

Eleven outbound `fetch` sites were tabulated. The ad pixels and the label printer
had timeouts. **The payment processor, the membership processor and both email
providers did not** — the three that move money and the one that tells the
customer it happened. A `fetch` with no signal waits as long as the other end
wants; on a request path the shopper sits on "Processing…" until the platform
kills the function.

All four now carry `AbortSignal.timeout`. 15s for the two processors, matching
`SHIPPO_REQUEST_TIMEOUT_MS` — the timeout this codebase already chose for a third
party on a request path — and 10s for email, which is not on a request path.

**A timeout on the checkout call is only safe because the retry returns the same
session.** `"Idempotency-Key": input.orderId` is what makes timing out unable to
double-charge, so the test asserts the two together and will fail if either is
removed.

| mutation | result |
|---|---|
| remove the checkout timeout | **1 failure** |
| remove one of the two Veyra timeouts | **1 failure** |
| remove the Resend timeout | **1 failure** |
| drop the idempotency key that makes a timeout safe | **1 failure** |

`third-party-timeouts.test.ts` is a source-text test and says so in its own
header, with the reason: it asserts a property of the **call site** — "this fetch
was given a deadline" — which no behavioural test can observe without a hanging
server per provider. It is a completeness check over a list, not a substitute for
testing what those modules do. Its matcher balances to the call's closing paren
rather than taking a fixed window (a fixed one either misses a long options
object or spills into the next call), and it carries three controls proving the
matcher discriminates: timed vs untimed, one timed call not vouching for an
untimed one beside it, and a comment between the call and its options not hiding
the option.

### Already closed by the merge

**K-27** — `partially_refunded` orders are no longer dropped from the sales-tax
report; the Block F merge resolution covers it. **K-26 remains open**:
`taxableSales` is still `subtotal − discount` and does not include taxed shipping.

## 4.5 K-15 — the throttle that only stopped serial traffic

Two independent defects in one 40-line module.

**(b) The count and the record were not atomic.** It SELECTed the count, then
INSERTed. Two hundred requests arriving together all read a count below the
limit, all passed, and all then inserted. **The effective limit under a
concurrent burst was unbounded** — it only ever throttled *serial* traffic, and
automated abuse is concurrent by construction.

Behind that gate: coupon-code enumeration (**the only barrier** — codes are
minted as `SAVE-XXXX` and matched case-insensitively), order creation, payment
submission, wallet session minting, and two unauthenticated email-sending forms.

**Fix:** record first, then count, and compare `> limit` instead of `>= limit`
so the limit-th request is still the last allowed one. A burst is fully counted
before any member of it asks how big it is. The trade — a denied request still
costs a row — is stated in the code and is the safe direction.

**(a) It failed open on any storage error, silently.** No log, no alert, no
distinguishable return value: *"under the limit"* and *"the rate-limit table is
unreachable"* looked identical to every caller.

**Fail-open is KEPT** — it is a documented, deliberate posture, an abuse
speed-bump must not take down checkout, and admin login has its own separate
mechanism (`admin_login_attempts`) that does not depend on this module. What
changed is the silence: a `degraded: true` on the result, a console line, and a
`critical` `rate_limit_degraded` alert throttled to one per five minutes, because
a storage outage hits every route at once and an alert per request would bury the
signal it exists to raise.

**Severity bounded by a production read:** `rate_limit_hits` **does** exist in
production, so K-15's worst case — every rate limit in the application silently
off — is *not* live. The concurrency hole is.

| mutation | result |
|---|---|
| back to count-then-insert (the original) | **2 failures** |
| stop alerting on a degraded limiter | **4 failures** |
| stop flagging `degraded` in the return value | **3 failures** |
| alert on every request (bury the signal) | **1 failure** |
| never deny anything | **3 failures** |

One assertion was corrected rather than left as written: the burst test first
asserted `allowed > 0`, which encoded an interleaving the fake cannot produce.
Under the perfect simultaneity of the fake every member of a 200-burst is denied,
and that is correct and safe. The assertion is now `<= limit` plus `< 50` (the
pre-fix behaviour was 200), and the serial test is what proves legitimate traffic
is not locked out.

## 4.6 Postgres, and a property working as designed

The container reclaimed the test Postgres twice during this block. Both times the
database-backed suites **errored** rather than quietly passing — the property
Block F recorded and `F-014` exists to guarantee. It is the reason the gate in
Phase 7 checks the cluster is up rather than assuming it.

`scripts/start-test-postgres.sh` is committed so the gate is reproducible.
