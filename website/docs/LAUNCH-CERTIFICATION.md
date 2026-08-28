# Vanta Labs — Launch Certification

**Block M, final integration.** Branch `claude/vanta-audit-final-block-m-faj8j6`,
134 commits off `main`. Nothing merged to `main`. Nothing deployed. No
production migration applied.

Working record: `docs/INTEGRATION-LOG.md`. Deployment sequence:
`docs/DEPLOYMENT-ORDER.md`.

---

## 1. INDEPENDENCE DISCLOSURE — read this before the verdict

**I fixed this code and I am also certifying it. That is not independence, and
no part of this document should be read as though it were.**

Concretely:

- Every change I authored is **unreviewed by anyone but me**. No human has read
  a line of it.
- Every test I wrote was written by the same author as the fix it covers. A
  test and its subject sharing an author share the author's blind spots.
- Mutation testing is the partial answer to that and the reason it was used on
  every fix: it asks whether a test can *detect* a broken fix, which is a
  question the author's intentions cannot answer. **It is not a substitute for
  review.** It proved its worth here — see §4, where two of my own mutations
  survived and turned out to be gaps in my tests, not equivalent mutants.
- Where I judged something "working as designed", I was judging code I had
  often just read for the first time.

**The evidence in this document is graded. The grades are the load-bearing
part.** A `NOT VERIFIED` here is a real answer, not a gap I ran out of time to
close, and I have not upgraded a single grade to make a section look finished.

---

---

## 1b. THE INDEPENDENT REVIEW HAPPENED, AND IT FOUND TWO P0s

**Condition 2 below — "a human reads the diff" — was acted on. Someone did, with
no knowledge of intent, reading the code before any of the reports and using
production only for read-only verification. Six findings came back, two of them
P0. The owner independently confirmed both before any work started.**

This section exists because §1 predicted exactly this and should be graded on it.
§1 said a test and its subject sharing an author share the author's blind spots.
That is precisely what happened, and the verdict below was too confident as a
result: it stated "the P0 in the commission path is fixed and proven" while the
commission path still carried an unrecoverable P0 that no test could see.

| # | Severity | What | Where it came from |
|---|---|---|---|
| 1 | **P0** | A failed commission accrual was permanently unrecoverable — both paid lanes consume a single-use claim and THEN accrue | **new code from this block** |
| 2 | **P0** | Cancelling a manually-paid order wrote off its stock; the K-17 return path was inert on one lane, and inert on the other for a second reason | **new code from this block** |
| 3 | P1 | A new dose stole `is_default` and `position` from an existing one | **regression this block introduced** |
| 4 | P1 | `isRevenueOrderStatus` — the declared "single source of truth" — had zero call sites | **new code from this block** |
| 5 | P2 | A textual assertion blind to the only defect in the file it guarded, hiding a ~3× revenue overstatement | assertion new; underlying bug pre-existing |
| 6 | P2 | The rate limiter became a write amplifier and self-locked user-keyed buckets | **new code from this block** |

All six are fixed, each with a reproduction, a RED test that failed for the right
reason, a root-cause fix, and recorded mutation controls. Full working record in
`INTEGRATION-LOG.md` under **BLOCK N**.

### The pattern, which matters more than any individual finding

**Five of the six were introduced by the fixes in this block, not found beneath
them.** And both P0s were the same shape:

> **A new module confidently asserted, in a comment, an invariant that another
> module was already known to violate.**

- `order-cancellation-inventory.ts` wrote *"`paid_side_effects_at` is the signal,
  because it is the latch under which the paid side effects ran"* — true of one
  of the two paid lanes.
- `admin-dashboard-rollups.sql` wrote *"Every function mirrors the JS logic it
  replaces EXACTLY (same status filters, same net-of-refund revenue...)"* — one
  function had no status filter at all.

Neither was sloppy logic. Both were confident prose about code in another file,
never checked against that file. A dedicated sweep for that specific shape is
recorded in `INTEGRATION-LOG.md`.

### What this does to the grades

Nothing below is upgraded. Two things are **downgraded**:

- Any claim that the commission path was "proven" is withdrawn. It was proven
  against doubles that could not fail — every accrual double accepted any insert,
  so the failure branch was unreachable.
- Mutation testing is confirmed as valuable **and as insufficient on its own**.
  §4 already reported two surviving mutants. Block N produced **four more**, and
  every one turned out to be a gap in the test rather than an equivalent mutant.
  The rule that came out of it: **write the mutation first, and if it survives,
  suspect the test before the code.**

## 2. THE VERDICT

### Ship the code. Do not ship it *today*, and not without the migrations.

**CONDITIONALLY CERTIFIED FOR LAUNCH**, on four conditions:

1. **Apply the migrations in `DEPLOYMENT-ORDER.md`, in that order, before the
   code.** Two are launch blockers. Step 4 is the one order-sensitive step.
   Every step has an exact rollback; four have committed `ROLLBACK-*.sql` files.
   **Step 5b is no longer optional** — it now runs before the deploy (finding 6).

   **This condition was previously undersold, and the wording that undersold it
   is corrected in `DEPLOYMENT-ORDER.md`.** Step 1's order note used to say the
   code half was "harmless" without its migration. It was not: deploying the code
   first destroyed one commission per referred order, permanently, because the
   accrual gets exactly one attempt after a single-use claim. Finding 1 makes
   that recoverable via a repair sweep — a safety net, not a licence. Apply the
   migrations first regardless.
2. **A human reads the diff — STILL OUTSTANDING, and now larger.** An
   independent review has since read it and found two P0s (§1b), so this
   condition is partly discharged and its value is no longer hypothetical. It is
   not closed: the review was itself unreviewed, and Block N added **2,902
   insertions across 30 files — 566 of them production code** — that **nobody
   has read at all**. (I first reported this as "~1,400 lines" from memory
   rather than measurement; the register in `INTEGRATION-LOG.md` under "BLOCK N
   — WHAT STILL NEEDS A HUMAN READ" has the measured breakdown and a
   highest-risk-first reading order.) The highest-risk files
   are `payment-webhook.ts`, `payment-service.ts`, `membership-billing.ts`,
   `/r/[code]/route.ts`, and now `commission-accrual-repair.ts` and
   `order-cancellation-inventory.ts`.
3. **Decide the owner-decision items in §6.** One of them (affiliate
   attribution as essential storage) is a published-policy question, not an
   engineering one.
4. **Run the smoke test in `DEPLOYMENT-ORDER.md` after deploying**, and treat
   its six ABORT conditions as binding.

### Why "ship" rather than "hold"

The core transaction works and has now been proven to work end to end, from a
clean browser, on the final build, with the database checked against the screen
at every step. That had **never been done in any environment** before this
audit.

~~The P0 in the commission path is fixed and proven.~~ **Withdrawn — see §1b.**
The commission path carried a second, unrecoverable P0 that the independent
review found and that no test here could have caught. It is now fixed, tested
against a double that models production's real CHECK constraint, and backed by a
repair sweep. "Proven" is a word this document should use more carefully than it
did. The orphan-order and
denial-of-inventory hole is fixed and proven. The renewal double-charge is
fixed. The consent violation is fixed.

### Why "not today"

Two of the migrations are launch blockers, and until they are applied the code
is **correct but under-served by the database**: commissions cannot be written
at all without Step 1. Deploying the code first would produce a store that
takes orders and silently accrues no ambassador commission — which is precisely
the defect this audit opened with.

---

## 3. THE ONE TEST THAT OUTRANKS EVERYTHING

*"Prove ONE COMPLETE PURCHASE… cart → discount applied → payment → order row
written → inventory decremented → confirmation email queued → order lands in
the fulfilment queue"*, checking the **database** against the **screen** at
each step.

**Done twice.** Once mid-audit, once as a cold start from a cleared browser on
the final bundle after the last code change. Identical to the cent.

| | Screen | Database | |
|---|---|---|---|
| Subtotal | $131.10 | `subtotal` 131.10 | ✅ |
| Ambassador EXPLICIT15 | −$13.80 | `discount_amount` 13.80 | ✅ |
| Shipping | $15.00 | `shipping_amount` 15.00 | ✅ |
| Service Fee (3%) | +$3.97 | `card_processing_fee` 3.97 | ✅ |
| **Total** | **$136.27** | `amount_paid` **136.27** | ✅ |

| Effect | Measured |
|---|---|
| Order paid, `paid_at` set, `paid_side_effects_at` claimed | ✅ |
| Provider event recorded | 1 row ✅ |
| **Inventory 25 → 23**, reservation `finalized`, `reserved_quantity` 0 | ✅ |
| Confirmation email queued (`order_email_log` + `pending_emails`) | 1 + 1 ✅ |
| Fulfilment queue | `awaiting_fulfillment` ✅ |
| **Commission** | 15.00% · **$17.60** · `pending` ✅ |

`131.10 − 13.80 = 117.30` · `15% × 117.30 = 17.60`. The ambassador is paid on
what the customer actually paid.

**And the same order followed across the operator's screens**: `/admin/orders`
field-for-field, `/admin/fulfillment` "Ready to fulfill", `/admin/partners`
"Commission Owed $17.60 — $0.00 ready · $17.60 holding", `/admin/reconciliation`
all five checks zero with its incompleteness counter **visible rather than
absent**.

Grade: **BROWSER-PROVEN**, twice, on a production build.

---

## 4. WHAT WAS FIXED IN THIS BLOCK

Every fix below: reproduced → fixed → tested → **mutation-tested** → re-verified.

| ID | Defect | Mutations | Grade |
|---|---|---|---|
| **M-01 / G-01** | Commission accrued on the pre-discount figure — the P0 | proven by 4-arm production probe | DATABASE-PROVEN |
| **M-02** | Commission migration dropped a constraint **by name**; a duplicate under another name survived and every accrual failed | — | BROWSER-PROVEN |
| **G-03** | Checkout dying at the processor left a `pending_payment` order **and a 15-minute stock hold**, while telling the customer "no order was placed" | 5 applied, **5 killed** | BROWSER-PROVEN |
| **K-03** | Membership renewal could **charge twice**: idempotency keyed to the sweep's date, post-charge write unchecked | 5 applied, 4 killed, **1 equivalent (proved)** | BEHAVIORAL + DATABASE |
| **K-04** | Affiliate link recorded utm/IP/UA/referrer **before any consent**, against three published policy statements | 7 applied over 2 rounds, **7 killed** | BROWSER-PROVEN |
| **—** | `endsLabel` advertised a coupon **a full year away** as ending tonight; scratch tests in a stray path were **pinning the bug** | 4 applied, **4 killed** | BEHAVIORAL-TEST-PROVEN |

### The two mutations that survived, and what they mean

**This is the most useful thing in this document**, because it is where my own
work was caught being wrong.

- **K-04, round 1.** Replacing the consent check with a constant — reinstating
  the defect *verbatim* — left every one of my source-inspection assertions
  passing, because the identifier was still present and merely no longer
  load-bearing. **Source matching cannot distinguish code that honours consent
  from code that mentions it.** That forced a second suite calling the real
  route handler and asserting on the rows actually inserted. Both survivors
  died in round 2.
- **K-03, mutation 5.** Dropping `tier.id` from the idempotency key survived
  and **is reported as a genuinely equivalent mutant, with proof**, not papered
  over: `customer_memberships` has `user_id` as its PRIMARY KEY (verified
  against production), and a tier change rewrites `next_billing_at`, so two
  tiers for one user in one period is structurally unreachable.

### Corrections I made to my own work

Recorded because an audit that hides its own errors is worth nothing:

- A test that **passed for the wrong reason** — two sweeps in one run land on
  the same date, so the defective code satisfied it. Rewritten with a moved
  clock to actually cross UTC midnight; it then failed showing two keys for one
  renewal ninety seconds apart.
- A test whose **name over-claimed** ("…and two different tiers") while only
  varying the user. Renamed to what it proves.
- Three suspicions **raised and then disproved on measurement**: a screen-vs-DB
  money mismatch (resolved once an async fetch completed), continuous layout
  shift on checkout (scrollY and scrollHeight unchanged over ten samples — it
  was a collapsed disclosure panel), and a fixed header intercepting checkout
  clicks (header bottom y=81, control y=849).

---

## 5. THE GATE

Merged tree, every change in place.

| | Result |
|---|---|
| `tsc --noEmit` | **clean** |
| `eslint` | **0 errors**, 42 warnings (39 in test files, all unused-vars) |
| `vitest run` | **259 files · 4141 tests · 0 failed** |
| **Skipped** | **0** |
| `next build` (after `rm -rf .next`) | **exit 0** |

**On the zero.** A first run showed 75 skipped — the DB-backed concurrency and
financial-reporting suites, which **announce their own skips and say what is
not being proved**. Rather than accept that, a throwaway Postgres was attached
and all 75 were run. Double payout, the exactly-once payout claim, and the
paid-side-effects claim under concurrent delivery are **executed**, not assumed.

---

## 6. WHAT REMAINS OPEN — and why each one is allowed to be

Only four categories may remain open. Every item below is in one of them.

### (1) Needs the owner's business decision

| Item | The decision |
|---|---|
| **Affiliate attribution as essential storage** | The `vl_referral_code` cookie and the click row that pays an ambassador are still written regardless of consent. Whether they are "essential" is a **published-policy and legal** question. Gating them would silently cut ambassador commissions. The tracking fields the policy itemises are already fixed (K-04); this is the residue. |
| **K-18** | Persisting the card lane's compliance acknowledgement needs three new `orders` columns. |
| **Historical refund restock** | Orders refunded before the inventory-return migration lost their units. Replaying is a data decision — which orders, and does the physical shelf agree. |

### (2) Needs production mutation or deployment approval

| Item | Status |
|---|---|
| **7 migrations** | Staged in `DEPLOYMENT-ORDER.md` with exact SQL, exact rollback, and a verify step each. **Not applied.** The standing rule is to ask every time, and a schema change on a live store with nobody awake is exactly what that rule exists for. |
| **C-02** | The `pending_emails` order link needs its migration before the fix is live. |

### (3) Needs an external service or credential I do not have

| Item | Status |
|---|---|
| **I-11 (half)** | ~~Two grantors hold the default privilege; `supabase_admin`'s half needs Supabase support.~~ **Re-measured 2026-08-28 and the diagnosis was wrong.** The residual function exposure reaches `anon` through **PUBLIC** in the object ACL, not through any `supabase_admin` grant — so no support ticket exists to raise, and the control is the per-migration `revoke ... from public` that `rpc-security-posture.test.ts` enforces. The **table** half of the same default was a genuine open hole (every new table fully writable by `anon` — the origin of the 64-of-70 sweep) and is now closed in production. |
| **Realtime, GoTrue auth, RLS policy correctness** | The harness has no realtime and no GoTrue, and connects as superuser. **NOT VERIFIED — and deliberately not upgraded.** |
| **Live processor, live email, Shippo label purchase** | No real charge, mail or label was permitted. |

### (4) Genuinely cannot be verified safely, or is a measured residue

| Item | Measurement |
|---|---|
| **C-08** | 41 `sendEmail` call sites; **37 awaited, 14 inspect the result.** The remainder is systemic hardening across many files, not one defect. A sweeping late-audit refactor is what the "smallest root-cause fix" rule exists to prevent. Reported with the number. |
| **K-02** | Cart-recovery templates hardcode "5% off" in five places while the discount is admin-configurable. **Confirmed still present.** P2: misstates a discount to a customer. |
| **K-06** | `admin-control.ts` has 5 `Number.isFinite` guards against 8+ bare `Number(...)` reads; `discountPercent` and `couponExpirationHours` — cart-recovery coupon money — are among the unguarded. **Confirmed still present.** |
| Remaining WORKLIST-2 entries | Carried with their evidence grade in `INTEGRATION-LOG.md`. **None is marked closed on the strength of a label** — grepping finding IDs was tried and rejected as a signal after `C-03` was found fully fixed with zero references. |

---

## 7. EVIDENCE GRADES, HONESTLY

| Area | Grade |
|---|---|
| Complete purchase, screen vs database | **BROWSER-PROVEN** ×2 |
| Commission accrual and the M-01 invariant | **BROWSER-PROVEN** + DATABASE-PROVEN |
| Inventory decrement, reservation lifecycle | **BROWSER-PROVEN** |
| Orphan-order cleanup (G-03) | **BROWSER-PROVEN** |
| Consent gating (K-04) | **BROWSER-PROVEN** |
| Admin operation, 26 routes | **BROWSER-PROVEN** |
| Mobile layout, 390×844, 16 routes | **BROWSER-PROVEN** (no horizontal overflow) |
| Renewal double-charge (K-03) | **BEHAVIORAL-TEST-PROVEN** |
| Concurrency: double payout, exactly-once claims | **DATABASE-PROVEN** (real Postgres) |
| Production schema claims | **DATABASE-PROVEN** (rolled-back probes, read-only) |
| **Signed-in customer flows** | **NOT VERIFIED** — no GoTrue in the harness |
| **RLS policy correctness** | **NOT VERIFIED** — harness connects as superuser |
| **Realtime** | **NOT VERIFIED** — not implemented in the shim |
| **Live payment capture, live email, label purchase** | **NOT VERIFIED** — prohibited, correctly |

---

## 8. THE SHORT VERSION

The store can take an order, charge for it correctly, decrement the right
stock, tell the customer, pay the ambassador the right amount, and put the
order in front of whoever has to pack it. That chain now holds end to end and
has been watched doing so, twice, against a real database.

It could not do that when this block started — a duplicate constraint under a
second name meant **every commission silently failed**, and only a real
purchase through a real browser exposed it.

Apply the migrations first. Have a human read the diff. Then ship.

*Prepared by the same agent that wrote the fixes. See §1.*
