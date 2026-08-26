# Vanta Labs — Final Certification Report

**Date:** 2026-08-26
**Branch:** `claude/vanta-labs-audit-resume-754dol`
**Baseline:** `9aea901` (what production serves today)
**Companion files:** [ledger](./FINAL-CERTIFICATION-AUDIT.md) · [system map](./PHASE1-SYSTEM-MAP.md) · [coverage matrix](./AUDIT-COVERAGE-MATRIX.md)

---

## Verdict

# 🟡 GO WITH CONDITIONS

**The store is not certified.** Certification required every item in the
coverage matrix to be ✅ or explicitly `NOT VERIFIED` with a reason. All 45
tracked rows are now accounted for — but only **4 are ✅**. **41 are not
certified**, and for most of them the reason is that the work was not reached,
not that it was cleared.

What this verdict does say, with evidence:

- **Seven defects were reproduced and repaired this audit**, five of them P0.
  Every one is covered by a regression test that failed first, for the right
  reason, with a negative control proving the test can still fail.
- **The two BRUTUS doors are closed in production.** Both identity repairs are
  live and verified there by probes that rolled themselves back.
- **Nothing found in this audit indicates the storefront is unsafe to keep
  serving customers today.** Every defect found sits in the affiliate/ambassador
  money path, which has never moved a real dollar (`commissions`, `payouts`,
  `partner_payouts`, `referral_orders` are all still **0 rows**).

What it does **not** say: that checkout, payments, inventory, fulfillment,
financial reporting, admin, or security have been verified. **They have not been
exercised at all.** See [What was not verified](#what-was-not-verified).

### The conditions

| # | Condition | Why it is a condition and not a recommendation |
|---|---|---|
| 1 | **Deploy this branch.** | Four P0 repairs (F-016, F-017, F-018, F-019) exist only in the repository. Production still runs the double-payout race, the wrong-commission approval email, the silent no-op approval, and the split accrual/payout gates. |
| 2 | **Deploy order is already satisfied — do not reorder it.** | `partner-portal.ts` calls `create_partner_invite`, which was applied to production *first*, deliberately. Reverting the migration without reverting the code breaks admin invites. |
| 3 | **Do not release an affiliate payout until condition 1 is met.** | The payout path is where the unrepaired P0s live. No payout has ever run, so this costs nothing today. |
| 4 | **Decide on the COA claim (F-006).** | Every visitor is told "PUBLISHED COAS" and "COA Documented". `coa_records` holds **0 rows** and no product carries a COA URL. This is a claims exposure, not a code defect, and only you can resolve it. |
| 5 | **Decide on CI (F-015).** | Nothing runs the suite automatically. Every regression test this audit added proves a defect *was* fixed; none of them stops it coming back. |
| 6 | **Treat the unverified list as open risk, not as passed.** | Checkout and payments in particular have never been exercised end to end in this audit. |

---

## What was repaired

All seven were reproduced before being touched, and all seven have negative
controls. Full evidence, including the RED output, is in the ledger.

| ID | Defect | Sev | State |
|---|---|---|---|
| **F-013** | The **admin invite** path re-opened BRUTUS: two un-transacted inserts left an orphan `partners` row holding a referral code checkout would never honour — and because that orphan carries `auth_user_id`, it **silently defeated the F-009 repair**, stranding the person's real approved identity forever | P0 | **LIVE IN PRODUCTION**, verified there |
| **F-016** | The commission sweep overwrote money that moved while it was deciding. A refund reversed mid-sweep was un-reversed; **a commission already paid was dragged back into the payout queue and would be paid a second time** | P0 | Repo — needs deploy |
| **F-017** | **Historical defect #3.** The approval email quoted the pre-update `partners` copy, so approving and rate-setting in one action emailed the old number, and a `partners`-0 / `ambassadors`-real drift emailed **"0%"** | P0 | Repo — needs deploy |
| **F-018** | Approving someone with no `ambassadors` row returned 200, emailed them their approval, and wrote an audit row naming a table it never touched — a zero-row UPDATE is not an error | P0 | Repo — needs deploy |
| **F-019** | Accrual gated on `ambassadors.status`, payout release on `partners.status`. Drift either way half-broke the pipeline: money accrued that could never be released, or a payout stayed live for someone the money table called disabled | P0 | Repo — needs deploy |
| **F-014** | The database-backed proofs — the *entire* runtime evidence for both BRUTUS repairs — **skipped silently**. The ledger's claim that they "skip loudly" was false; Vitest swallows `console.warn` from a skipped module | P1 | Repo |
| **F-015** | **There is no CI.** No `.github/`, and the Vercel build is `next build` with no test step | P1 | Open — your call |

### Certified as sound under real contention

Not everything examined was broken. These were tested with genuinely
overlapping calls on separate pooled connections, and they hold:

- `markCommissionsPaid` **pays exactly once** under two simultaneous releases,
  and keeps `partner_payouts` and `payouts` in step.
- The paid-side-effects claim (`update … where paid_side_effects_at is null
  returning`) is won by **exactly one of eight** concurrent deliveries. This is
  the mechanism preventing double commissions and double stock decrements on a
  replayed payment webhook, and it is correct.
- RLS is enabled on **68 of 68** public tables.

### Three false passes found — the most transferable result

1. **A fake that returned live row references** made two of my own tests pass
   against unfixed code, because the caller's "before" snapshot appeared to
   update itself. PostgREST returns JSON over HTTP; rows do not change under you.
2. **`referral-code-email-wiring.test.ts` — the file whose header reads "THE TEST
   THAT WOULD HAVE CAUGHT IT"** — answered `null` for every `ambassadors` read,
   so the scenario in its own header was only ever half modelled. It could not
   have caught F-017.
3. **Two more fakes could not express a write that matched nothing**, which is
   precisely the shape of F-018.

This is the concrete answer to "how did 3,566 passing tests coexist with every
defect in the brief": in part they were testing fakes shaped more conveniently
than the database.

---

## What was NOT verified

Nothing below was upgraded to close a gap. Each is open with its reason.

### Blocked by the environment (7 rows)

The network allowlist **never took effect**. Re-measured at the end of this
session: the egress proxy still answers `403` to `CONNECT` for the audit harness
(`snnezhxvssochqpqsjcm.supabase.co`) and for the production domain. A locally
running app therefore cannot reach any database, and no browser test that needs
data can run.

- Customer journey (Phase 3) · Mobile / responsive 390×844 (13) · Complete
  browser regression (18) · Preview verification (20) · Browser storage and
  stale state (req 1) · Domain / DNS / TLS / redirects (req 7) ·
  Accessibility (req 9)

Only the age gate was ever browser-proven, in an earlier session, against a
production build.

### Not reached — the honest reason for most of the list (34 rows)

Twenty-six rows are 🟨 "partially covered" and eight are ⬜ "not started". Only
four of the 🟨 rows carry a reproduced defect (affiliate, emails, test quality,
concurrency); the other twenty-two are mapped hypotheses with no runtime
evidence either way.

**Checkout and payments were never exercised.** Neither were inventory and
stock display, fulfillment and Shippo, financial reporting, the admin as an
operator, IDOR and authorization, discounts and memberships, the email retry
sweep (a P0: sweep-then-retry can send a customer a **second receipt**),
cross-system collisions, multi-tab, time and timezone boundaries, money rounding
boundaries, upload safety, backup and recovery, SEO, dead code, rate limiting,
stale browser state, third-party degraded mode, background jobs, or the
unknown-unknown pass.

**Also still open in the subsystem that was audited:**

- `markCommissionsPaid` flips commissions to `paid` **before** the payout rows
  are inserted, with no transaction. If the `payouts` insert fails, commissions
  read `paid` with a `payout_id` pointing at a payout that does not exist —
  unpayable and unreversible. Reproducible; not reached.
- `/r/[code]` attributes clicks for codes checkout will never honour.
- Row-cap truncation on money reads that were never converted to server-side
  aggregation.
- `fetchAuthoritativeRates` returns an empty map on **any** error, silently
  reverting every displayed rate to the `partners` copy.

**Scale of what remains:** the system map catalogues **183 risks** across 11
subsystems. This audit reproduced **seven**. The rest are `SOURCE-INSPECTED`
hypotheses — a prioritised work queue, not a defect register, and not evidence
of either safety or failure.

### Corrected in writing

- The map states `partner_payouts.ambassador_id` references `ambassadors(id)`.
  Live `information_schema` shows **no foreign key at all** on that table. The
  P0 rationale that depended on it is half wrong; the ordering risk itself
  stands.
- Two earlier findings were disproved before this session (F-005 alert count,
  F-007 seeded program figures) and are recorded as NOT defects.

---

## Final regression gate

Run on the final commit of this branch, with a database present:

| Gate | Result |
|---|---|
| `npm run test` | **207 files / 3,607 tests — all passing** |
| `npx tsc --noEmit` | exit 0 |
| `npm run lint` | exit 0 — 0 errors (38 pre-existing warnings) |
| `npm run build` | exit 0 |
| Production `partners` / `ambassadors` | 7 / 7, **7 converged pairs, 0 orphans** |
| Production DB functions | F-009 unchanged at its recorded checksum; F-013 live |

Baseline for comparison was 201 files / 3,566 tests. The audit added 6 files and
41 tests, 23 of which run only when `VANTA_TEST_DATABASE_URL` is set:

```
initdb -D /tmp/vantapg -A trust -U postgres
pg_ctl -D /tmp/vantapg -o '-p 55432 -k /tmp' start
VANTA_TEST_DATABASE_URL=postgres://postgres@localhost:55432/postgres npm run test
```

Without it those 23 skip. They now say so on stderr (F-014) — but nothing
automated will ever set it (F-015).

---

## Production safety

No real charge, refund, payout, label purchase, customer email, account
creation, coupon redemption, or destructive database operation was performed.

Production was written to **once**, on your explicit instruction: the
`partner_invite_atomic_and_convergent` migration. Its behavioural verification
ran inside a transaction that ended in `RAISE EXCEPTION`, so every row it
created was rolled back — confirmed afterwards at 7 partners, 7 ambassadors,
zero probe rows.

Revert path, exact:

```sql
drop function public.create_partner_invite(uuid,uuid,text,text,text,numeric,uuid);
```

…reverted together with the `createPartnerInvite` change in `partner-portal.ts`.

---

## If you continue

In the order I would take them:

1. **Deploy this branch** — four P0 repairs are waiting.
2. **Checkout and payments end to end.** The largest unverified surface, and the
   one carrying real money today. Needs either the allowlist or a local
   PostgREST shim.
3. **Fix the allowlist**, which unblocks six items at once. The setting is
   under the environment's **cloud icon → gear → Network access → Custom**, and
   it needs a **new session** to take effect.
4. **The `pending_emails` retry P0** — a customer receiving a second receipt is
   customer-visible and reproducible without a browser.
5. **`markCommissionsPaid` ordering**, before any real payout runs.
6. **CI**, so the 41 new tests start protecting something.
