# FINAL VERIFICATION LOG — independent pre-merge review

Session: final-verify-merge (branch `claude/vanta-labs-final-verify-merge-84fzl0`,
based on the integration head `eb80a55`).

Every number below came from a command run in this session. Where it contradicts
a number written elsewhere in this repository, the contradiction is stated.

---

## PART 1 — MERGE SAFETY

### 1.1 Ancestry

```
$ git rev-parse origin/claude/vanta-labs-code-review-j6qb7t
eb80a5505378e4ea564eead9d6a07023409be5b0
$ git rev-parse origin/main
9aea901ede54914a8f5be8a35066f0ffb0a76efa
$ git rev-parse origin/claude/vanta-audit-final-block-m-faj8j6
0ca55216e773d430c13a9b4535a2dd673ea01cd4
$ git merge-base --is-ancestor 0ca5521 origin/claude/vanta-labs-code-review-j6qb7t
YES ancestor
$ git merge-base --is-ancestor 9aea901 origin/claude/vanta-labs-code-review-j6qb7t
YES
```

Block M's head **is** an ancestor of the integration head. The prompt's
precondition holds. `faj8j6` is fully contained and is correctly treated as
superseded.

### 1.2 Does it merge cleanly / has main moved?

`main` is at `9aea901` and is an **ancestor** of the integration head. main has
not moved since the audit began. The merge is therefore a strict fast-forward
with **zero possible conflict**; no throwaway-worktree conflict test is needed
to establish that, and none can produce a conflict.

### 1.3 Actual size of the work

```
$ git diff --shortstat 9aea901..eb80a55
 239 files changed, 40721 insertions(+), 1391 deletions(-)
$ git rev-list --count 9aea901..eb80a55
140
```

Production code only (`website/src/**`, excluding `*.test.ts`):
**7,281 insertions / 743 deletions**.

### 1.4 Commits stranded on block branches — NONE

```
for b in <all ten block branches>; do git rev-list --count eb80a55..origin/$b; done
```

| branch | commits not reachable from integration head |
|---|---|
| claude/vanta-audit-final-block-m-faj8j6 | 0 |
| claude/audit-superpowers-playwright-extension-c2oyhm | 0 |
| claude/vanta-labs-audit-resume-754dol | 0 |
| claude/browser-testing-blocks-gh-egmzo3 | 0 |
| claude/block-ab-audit-6fogsm | 0 |
| claude/block-ab-audit-8xz6fb | 0 |
| claude/block-ab-audit-o62bop | 0 |
| claude/block-ab-audit-zuuyuz | 0 |
| claude/audit-blocks-f-e-8jxi9v | 0 |
| claude/audit-parallel-assignments-block-k-r8fpix | 0 |

**No fix was lost in the merge.** This is the first direct test of that failure
mode and it comes back clean.

### 1.5 Working tree / pushed state

Integration branch working tree clean at session start; `origin/...j6qb7t` and
the local head are the same commit `eb80a55`. Nothing unpushed.

### 1.6 CORRECTION TO A REPORTED NUMBER

Block N's own commit message and `INTEGRATION-LOG.md` state Block N added
**2,902 insertions across 30 files**, of which **566** are production code.
Measured:

```
$ git diff --shortstat 0ca5521..eb80a55
 30 files changed, 3091 insertions(+), 126 deletions(-)
$ git diff --numstat 0ca5521..eb80a55 -- 'website/src/**' ':!*.test.ts' ':!*.sql'
insertions 602 deletions 81
```

The real figures are **3,091 insertions** and **602 lines of production code**,
not 2,902 and 566. Both of Block N's corrected figures were still undercounts.
The direction of the error is consistent: more unread code than reported.

**PART 1 VERDICT: CLEAN.** Ancestry holds, nothing stranded, fast-forward merge.

---

## PART 6.1 — DOES MERGING TO main DEPLOY?  **YES. THIS BLOCKS THE MERGE.**

This was checked before anything else that could lead to a merge, and it is the
single decisive result of this session.

**GitHub Actions:** none. `.github/workflows/` does not exist.

**Vercel git integration:** the project `vanta-labs`
(`prj_uUdavqjTwSFZCIJ8BxIrXjQp5ocI`, team `team_mYQ1nzN5ge279mjxaLG26lYe`) is
linked to `brendenhuntzinger1/vanta-labs` via the GitHub integration, and serves
`vantalabsresearch.com` / `www.vantalabsresearch.com`.

Direct evidence that a push to `main` deploys to **production**, from the
deployment history:

```
dpl_aQHYozA58q3v5MQ8hZRhG7a85Hck
  githubCommitRef: main
  githubCommitSha: 9aea901ede54914a8f5be8a35066f0ffb0a76efa
  target:          "production"
  state:           READY
```

```
dpl_gocvr3v4NyApggyC5m4jFxwkdzF1
  githubCommitRef: main
  githubCommitSha: b19db0c...
  target:          "production"
```

Every non-`main` branch push in the same window produced `target: null`
(preview). Every `main` push produced `target: "production"`.

**Merging this branch into `main` and pushing would immediately build and
promote 7,281 lines of unreleased production code to the live storefront.** The
owner authorised a merge, not a deploy. Per the standing instruction, this is a
STOP.

### 6.1b — and the deploy would be actively destructive

Not merely "a deploy we did not ask for". Verified by direct read against
production Postgres (`mlpimwgkwuqpsvsrlpqv`):

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid='referral_orders'::regclass;
```
```
referral_orders_payment_status_check
  CHECK (payment_status = ANY (ARRAY['paid','refunded','partially_refunded']))
referral_orders_order_id_key   UNIQUE (order_id)
```

The new accrual code writes `payment_status: "pending"`
(`src/lib/payment-webhook.ts:759`). **`'pending'` is not in the production
CHECK.** Every commission accrual would be refused with `23514` on the live
store, for every ambassador sale, from the moment the code is promoted — which
is exactly the failure mode the whole commission-lifecycle work exists to fix.

The migration that widens it — `src/lib/sql/referral-orders-commission-lifecycle.sql`
— is **staged and NOT applied**. `DEPLOYMENT-ORDER.md`'s migration-before-code
ordering is therefore not advisory: it is load-bearing, and it is confirmed
independently here rather than taken on trust.

**PART 6 VERDICT: MERGE BLOCKED.** Not by a defect in the code — by the fact
that the merge is a deploy, and the deploy is unsafe today.

---

## PART 4a — THE GATE (in progress at time of writing)

- `npm ci` — exit 0
- `npm run lint` — exit 0, **0 errors, 42 warnings**
- `npx tsc --noEmit` — exit 0
- `npm test` — see below
- `npm run build` — see below

Already observed during the test run, and material: three test modules print a
`SKIPPED:` banner and self-disable because `VANTA_TEST_DATABASE_URL` is unset —
`affiliate-concurrency`, `partner-status-integrity`, `partner-invite-atomicity`.
Their own banners state they cover double payout, the exactly-once payout claim,
the auto-approve read/write race and admin-invite atomicity, and that these are
**NOT covered by any in-memory test**. These are money-path proofs that did not
run in this gate.
