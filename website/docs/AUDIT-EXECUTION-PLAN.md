# Vanta Labs — Audit Execution Plan

**Standard chosen by the owner: FULLY CERTIFIED.** All 44 tracked requirements
(21 phases + 23 cross-cutting sections), all severities, not a launch-critical
subset.

This file exists because that standard spans many sessions, and the way a long
audit fails is not bad work — it is drift: priorities reshuffled, a session
running out of context mid-task, evidence never written down.

**Companion files**
- [`AUDIT-COVERAGE-MATRIX.md`](./AUDIT-COVERAGE-MATRIX.md) — status of all 44 requirements
- [`FINAL-CERTIFICATION-AUDIT.md`](./FINAL-CERTIFICATION-AUDIT.md) — the ledger: findings, evidence, repairs
- [`PHASE1-SYSTEM-MAP.md`](./PHASE1-SYSTEM-MAP.md) — 183 recorded risks, none reproduced

---

## The standard, per finding

A map entry is **not a finding**. It is a hypothesis. It becomes a finding only
after step 2, and it may only be called fixed after step 7.

1. **Reproduce** it. If it cannot be reproduced, mark it `UNCONFIRMED` in the
   ledger and move on — never silently "fix" it.
2. **Establish intended behaviour** from authoritative evidence (the code's own
   invariants, the database constraints, the owner's stated business rules) —
   not from what feels right.
3. **Write a regression test that fails**, and confirm it fails *for the right
   reason*. A test failing on missing scaffolding proves nothing.
4. **Smallest safe root-cause fix.** No refactoring adjacent code, no
   opportunistic tidying.
5. **Negative controls.** Mutate the fix; prove each test catches exactly what
   it claims to. Record which mutation broke which test.
6. **Verify through the real affected layers**, including Playwright where the
   behaviour is customer-facing.
7. **Update the ledger** with before/after evidence and the correct evidence
   grade, and tick the item in the coverage matrix.

**Do not upgrade an evidence grade without new evidence.** Reading code that
looks correct is `SOURCE-INSPECTED`, forever, until something runs.

---

## Ordering

Blocks are roughly one session each. Network-independent work comes first, so
the allowlist is never on the critical path.

| Block | Scope | Needs network? |
|---|---|---|
| **A** | **Phase 16 — concurrency & idempotency.** Genuinely overlapping calls, not sequential ones: payment webhook, order creation, inventory decrement/reservation, commission creation, analytics conversion, payout, partner creation, shipping webhook. Prove invariants after each race. | No |
| **B** | **Affiliate money P0s.** `markCommissionsPaid` ordering + FKs to different tables; `updatePartnerStatus` no-op on missing ambassador; accrual/payout gated by different tables; non-transactional mirror writes. Several fall out of Block A. | No |
| **C** | **Email.** Both P0s including **historical defect #3** (0% commission approval email — map says it still reads the non-authoritative table). Plus: dedupe, retry sweep vs send-once log, refund email with no dedupe, two shipping emails per parcel. Never send a real email. | No |
| **D** | **Fulfillment + inventory + discounts P0s.** Non-atomic status writes; `transaction_created` idempotency; `replaceProductDoses` dropping columns; membership tier change vs Veyra. | No |
| **E** | **Phase 15 — test quality.** Mutation-test the six flagged clusters: commission calculation, payout authority, inventory decrement, payment idempotency, email dedupe, fulfillment state regression. Any test that cannot fail gets replaced, not patched. | No |
| **F** | **Phase 10 — financial reporting.** Four surfaces disagree on what "an order" is; `reconciliation-math.expectedOrderTotal` is a fourth hand-copy of the total formula; sales tax counts partial refunds as full collections. Generate >1000 rows to prove the row-cap behaviour that production data cannot show. | No |
| **G** | **Phases 3, 5, 6, 7 — customer journey in the browser.** Stock display (F-001), referral discount in cart (closes historical #1), cart, discounts, checkout UI, membership. Against the harness only. | **Yes** |
| **H** | **Phases 13, 9, 10(a11y), 1(storage), 2(multi-tab).** Mobile 390×844, accessibility, hydration/JS errors, stale browser state, and genuine two-tab races. | **Yes** |
| **I** | **Phases 11, 12 — admin + security.** Operate the store as the owner. IDOR on `[orderId]`/`[partnerId]`/`[userId]`, capability gates on money-spending admin routes, the three IP resolvers, upload safety, plaintext credentials in `admin_audit_logs`. | Partly |
| **J** | **Phase 17 — cross-system collision matrix.** Every combination in the brief, each marked PROVEN / PARTIAL / UNTESTED / N-A. | Partly |
| **K** | **Timezone, money precision, dead code, config drift, legal/policy, third-party degraded mode, background jobs.** | No |
| **L** | **SEO, domain/DNS/TLS, backup/recovery, upload safety remainder, unknown-unknown pass.** The unknown-unknown pass must be done *without* consulting the historical bug list. | Partly |
| **M** | **Phases 19, 20, 21 — full regression, preview verification, final certification.** Traceability matrix completed, zero-regression gate, executive verdict. | **Yes** |

Blocks A–F and K need no network. If the allowlist is still broken, that is
**six sessions of work** that are not blocked by it.

---

## Handoff protocol

The single largest risk to this audit is a session ending mid-task with the
evidence only in its context window.

**When context gets tight, stop and write the handoff. Do not push through.**

Append to the ledger:

```
## HANDOFF — <date>, block <X>

COMPLETED THIS SESSION
  - <item> — <evidence grade> — <where the evidence lives>

IN PROGRESS, NOT FINISHED
  - <item> — reproduced? test written? fix applied? what is half-done
  - <exact next command or file to open>

DISCOVERED, NOT YET INVESTIGATED
  - <new leads, with file:line>

BLOCKED / NEEDS THE OWNER
  - <question, and what is blocked behind it>

NEXT BLOCK: <letter>
```

Then commit and push. An unpushed session is a lost session.

---

## Standing rules

- **Production stays protected.** No real charge, refund, payout, label
  purchase, email send, account creation, coupon redemption, or destructive
  database operation. Production reads are fine. Anything that mutates live
  customer or financial state needs the owner, every time.
- **Synthetic testing happens on the harness** (`snnezhxvssochqpqsjcm`), never
  production. Do not delete that project.
- **Do not rewrite healthy systems.** The brief is explicit: a working system
  stays working. No refactoring for preference.
- **Never test on `npm run dev`** in this environment. HMR is blocked, Fast
  Refresh resets React state mid-test, and it produces convincing false bugs.
  Use `npm run build && npm run start`.
- **Report what is true.** If something cannot be proven, it stays
  `NOT VERIFIED` in the final report. Do not upgrade a grade to close a gap.
- **Two findings have already been disproved** (F-005, F-007) after being
  written up as defects. Expect more of that, and correct them in writing.

---

## Definition of done

Certification is complete when:

- every one of the 44 items in the coverage matrix is ✅ or explicitly
  `NOT VERIFIED` with a stated reason
- no P0 or P1 remains unresolved or unexplained
- every repair has a regression test with a recorded negative control
- the traceability matrix maps each requirement to its evidence
- the full suite, typecheck, lint and build pass on the final commit
- production serves that commit and a post-deployment smoke check passed
- the executive verdict is one of the five defined grades, with the evidence
  behind it — and `🟢+ SCALE READY` is not awarded on passing tests alone
