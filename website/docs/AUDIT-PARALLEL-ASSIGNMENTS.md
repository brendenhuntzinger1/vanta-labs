# Vanta Labs — Parallel Audit Assignments

**Goal: complete all 44 requirements tonight.** One session cannot; several
working different blocks at once can. This file is the deconfliction contract.

Read first: [`AUDIT-EXECUTION-PLAN.md`](./AUDIT-EXECUTION-PLAN.md) (the standard
and block definitions), [`AUDIT-COVERAGE-MATRIX.md`](./AUDIT-COVERAGE-MATRIX.md)
(status), [`PHASE1-SYSTEM-MAP.md`](./PHASE1-SYSTEM-MAP.md) (the 183 leads),
[`FINAL-CERTIFICATION-AUDIT.md`](./FINAL-CERTIFICATION-AUDIT.md) (the ledger).

---

## Rule 1 — one branch per session

Branch from the audit branch, never from `main`:

```
git fetch origin claude/audit-superpowers-playwright-extension-c2oyhm
git checkout -B <your-session-branch> origin/claude/audit-superpowers-playwright-extension-c2oyhm
```

Push only your own branch. Never force-push. Never rebase another session's
branch.

## Rule 2 — do NOT edit the ledger

`FINAL-CERTIFICATION-AUDIT.md` and `AUDIT-COVERAGE-MATRIX.md` are shared files.
Concurrent edits to them will conflict and cost more time than they save.

Instead, write your findings to **your own file**:

```
website/docs/findings/BLOCK-<LETTER>.md
```

Use the ledger's format — finding id, evidence grade, severity, status,
reproduction, root cause, fix, tests, negative controls, verification. The
consolidation session merges every block file into the ledger at the end.

Finding ids are namespaced by block so they cannot collide: `A-01`, `A-02`,
`C-01`, and so on.

## Rule 3 — stay inside your files

If a fix requires editing a file another block owns, **do not edit it**. Record
it in your block file as `CROSS-BLOCK: <file> — <what needs changing and why>`
and carry on. The consolidation session resolves those.

Shared-by-everyone, edit with care: `src/lib/partner-portal.ts`,
`src/lib/quote-order.ts`, `src/lib/payment-webhook.ts`. If two blocks both need
one of these, the earlier-lettered block wins and the other records CROSS-BLOCK.

## Rule 4 — production writes need the owner

Any `apply_migration` or production data change: ask first, every time. Reads
are fine. The rolled-back `DO` block probe pattern (see F-009 and F-013 in the
ledger) is the approved way to prove behaviour against production without
persisting anything.

## Rule 5 — your own test database

Database-backed suites collide if they share one Postgres. Use the per-suite
database helper (`src/lib/e2e/suite-database.ts`) or give your suite its own
database name. A suite that silently shares state produces false passes.

---

## Assignments

| Block | Scope | Primary files | Network |
|---|---|---|---|
| **A+B** | Concurrency/idempotency, then affiliate money P0s | `partner-portal.ts`, `payment-webhook.ts` (affiliate paths only) | No |
| **C** | Email — all P0/P1, incl. historical defect #3 (0% commission approval email) | `src/lib/email/**`, `email/templates`, `retry-queue.ts` | No |
| **D** | Fulfillment + inventory + discounts P0s | `src/lib/shippo/**`, `inventory-*.ts`, `catalog.ts`, discount resolvers | No |
| **E** | Test quality — mutation-test the six flagged clusters; replace tests that cannot fail | `*.test.ts` only | No |
| **F** | Financial reporting — 4 surfaces disagreeing on "an order"; tax counting partial refunds as full; >1000-row truncation | `admin-profit.ts`, `admin-revenue.ts`, `admin-reconciliation.ts`, `reconciliation-math.ts`, `admin-tax-report.ts` | No |
| **I** | Admin + security — IDOR, capability gates, three IP resolvers, upload safety, plaintext creds in `admin_audit_logs` | `src/app/api/admin/**`, `admin-auth.ts`, `middleware.ts` | Partly |
| **K** | Timezone, money precision, dead code, config drift, legal/policy, third-party degraded mode, background jobs | scattered; record CROSS-BLOCK freely | No |
| **G+H** | **Browser**: customer journey, stock display, cart discounts, checkout UI, membership, mobile 390×844, accessibility, hydration, stale state, multi-tab | none — verification only | **Yes** |
| **J** | Cross-system collision matrix — needs other blocks' results, so start late | none — analysis | Partly |
| **M** | **Consolidation + final report.** Merges every block file into the ledger, completes the traceability matrix, runs the full regression, writes the verdict. **Single session, must be last.** | ledger, matrix | Yes |

---

## The one test that outranks everything

Whichever session gets the browser working first: **prove one complete purchase
end to end** before anything else on the browser list.

cart → discount applied → payment (mock) → order row written → inventory
decremented → confirmation email queued → order lands in the fulfillment queue.

Checkout is the core transaction of the business and it has never been
exercised in any environment. Everything else in the browser blocks is
secondary to that.

---

## Consolidation (block M)

Runs last, alone. It:

1. Merges every `findings/BLOCK-*.md` into the ledger, renumbering into the
   F-series
2. Resolves every `CROSS-BLOCK:` note
3. Updates the coverage matrix — every item ✅ or explicitly `NOT VERIFIED` with
   a reason
4. Runs the full suite, typecheck, lint, build on the merged result
5. Completes the requirements traceability matrix
6. Writes the executive verdict against the brief's five grades

**Nothing may be graded higher than its evidence.** A block that ran out of time
reports `NOT VERIFIED`, and that is a valid, honest outcome. The verdict is
allowed to be `🟡 GO WITH CONDITIONS`; it is not allowed to be optimistic.
