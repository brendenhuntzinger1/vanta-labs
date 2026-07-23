# Go live — 3 steps

No SQL. No environment variables. No copy-pasting codes.

### 1. Merge & deploy
Open the pull request on GitHub and click **Merge**. Vercel deploys it
automatically in a couple of minutes.

### 2. Run the database update once
Supabase → **SQL Editor** → **New query** → paste the whole
`website/src/lib/sql/deploy-run-once.sql` file → **Run**. Expect
"Success. No rows returned." (Safe to re-run; it never touches your data.)

### 3. Set your admin login code
Sign in to the admin, go to **My Account**, and use **6-digit login code** to
set it. That's the whole thing — change it there anytime.

---

That's everything for going live. From now on, your admin login is:
**username → password → 6-digit code**, and the code is managed from the
**My Account** page. Nothing else to configure.

---

<details>
<summary>For a developer, later: deferred reliability fixes</summary>

Four improvements were intentionally left out because they change the live
order/payment path and should be verified on a staging database first. Each has
ready-to-apply code, ranked by priority, in **`AUDIT_REPORT.md`**:

1. Inventory oversell — atomic decrement on sale
2. Card-webhook idempotency (atomic paid-claim)
3. Checkout idempotency (no duplicate orders on refresh/retry)
4. Membership proration + annual renewal cadence

The full audit — every finding, severity, and what was fixed vs. deferred — is
in `AUDIT_REPORT.md`.
</details>
