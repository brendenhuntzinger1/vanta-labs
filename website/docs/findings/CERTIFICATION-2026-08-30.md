# Certification session ledger — vanta-labs
Session start HEAD: 973d48086e52f29dfdd0bf333864c192f16884d4
Branch: claude/ecommerce-continuation-certification-s1g18l

## PART 0 — LSP verification (fresh session)

### F-001  TypeScript LSP is NOT running in this fresh session. Previous fix did not take effect.
Evidence:
- `pgrep -af typescript-language-server` -> no process (only the grep's own cmdline matched)
- `claude plugin marketplace list` -> only `claude-plugins-official`; `vanta-local` ABSENT
- `claude plugin list` -> only `superpowers@claude-plugins-official`; `vanta-typescript-lsp` NOT installed
- /root/.claude/plugins/known_marketplaces.json contained ONLY claude-plugins-official at session start
- /root/.claude/plugins/installed_plugins.json contains ONLY superpowers
Conclusion: project-level `extraKnownMarketplaces` in .claude/settings.json did NOT register
the vanta-local marketplace in this remote (cloud_default) environment.

### F-002  Previous session's diagnosis of the OFFICIAL plugin was CORRECT (verified independently).
/root/.claude/plugins/cache/claude-plugins-official/typescript-lsp/1.0.0/ contains exactly
README.md + LICENSE. No .claude-plugin/plugin.json, no .lsp.json. It genuinely declares no server.

### F-003  The vanta-local marketplace + plugin manifest are STRUCTURALLY VALID.
`claude plugin marketplace add ./.claude/plugin-marketplace` -> "Successfully added marketplace:
vanta-local". So the directory source and manifest parse fine. The defect is registration, not shape.
(State restored to baseline afterwards.)

### F-004  This harness exposes NO LSP tools to the model at all.
ToolSearch for lsp/definition/references/hover/diagnostics returns nothing LSP-related.
So even a running server would not give this session go-to-definition tools.

### F-005  Session is running in cloud_default, NOT the `vanta` environment.
CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE=cloud_default
CLAUDE.md claims Superpowers + CONTEXT7_API_KEY come from the `vanta` env setup script.
Superpowers is actually installed at USER scope from claude-plugins-official.

### F-006  typescript-lsp-config.test.ts only asserts config file SHAPE, never that a server runs.
It passed in the previous session while the LSP was inert. It cannot detect F-001.

### F-007  ROOT CAUSE of F-001, from the CLI's own debug log (/tmp/claude-code.log):
    14:58:11.800 [DEBUG] Skipping orphaned enabledPlugins entry
                 vanta-typescript-lsp@vanta-local: marketplace not registered
    14:58:37.663 [DEBUG] (same, on the post-hook plugin refresh)
Project `enabledPlugins` IS read (that is how the CLI knows the entry exists), but project
`extraKnownMarketplaces` is NOT applied, so the marketplace it names is never registered and the
plugin entry is orphaned. The plugin therefore never installs and no LSP server is ever started.

### F-008  (P1, SEPARATE AND BIGGER) All 31 checked-in project permission rules are DROPPED in cloud sessions.
    14:58:12.090 [DEBUG] Dropped 31 project-scoped permissions.allow entries — workspace not yet trusted
    "Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been
     trusted. Run Claude Code interactively here once and accept the trust dialog, or set
     projects[\"/home/user/vanta-labs\"].hasTrustDialogAccepted: true in /root/.claude.json."
CLAUDE.md asserts: "Supabase execute_sql and apply_migration are auto-approved in the checked-in
.claude/settings.json, so SQL calls don't prompt in any session, cloud or local."
THAT CLAIM IS FALSE for cloud sessions. Every Supabase/Playwright/GitHub/Vercel/Sentry allow-rule
the repo checks in is inert here. This is a documentation defect + an operational one.

### F-009  Ordering fact that makes a hook-based fix viable:
    14:58:13.358  SessionStart hooks run
    14:58:37.663  plugin cache refresh + re-resolve  (24s later)
    14:58:37.682  [LSP MANAGER] reinitializeLspServerManager() called
So a SessionStart hook that registers the marketplace is picked up by the later refresh.

### F-010  In THIS Claude Code build the LSP surfaces as DIAGNOSTIC ATTACHMENTS, not model tools.
`LSP Diagnostics: getLSPDiagnosticAttachments` is polled throughout the session; no LSP tool is
registered in the model's tool list. So "LSP tools available" is the wrong success criterion here;
"a typescript-language-server process is running and attached" is the right one.

## PART 1 — Test totals (measured this session, at HEAD 973d480)
- `npm test` (no DB): 396 files passed, 13 skipped (409). 6137 passed, 106 skipped (6243). EXIT 0.
  -> previous session's "6137 tests passing" claim VERIFIED.
- `VANTA_TEST_DATABASE_URL=postgres://postgres@localhost:55432/postgres npm test`:
  409 files passed (409). 6243 passed (6243). 0 skipped. EXIT 0.
  -> the 106 database-backed proofs DO pass against a real throwaway Postgres.

### F-011  Harness rate-limit isolation was applied to only 2 of the 4 QA harnesses.
qa-customer-journey.mjs and qa-purchase-path.mjs use a CSPRNG CGNAT client IP (x-real-ip).
qa-abuse-and-roles.mjs  -> every newContext() is bare; runs on the default client IP.
qa-role-boundaries.mjs  -> no x-real-ip / CLIENT_IP anywhere.
The abuse harness's whole job is to EXHAUST the per-IP signup/reset/resend buckets on that shared
address, and lib/rate-limit.ts also keeps a spent bucket in an in-process map, so deleting
rate_limit_hits does not clear it. TO CONFIRM: whether qa:all is repeatable inside the 15-min window.

## PART 2 — QA harness run (local harness, HEAD 973d480)

### F-012 (P0, TEST INTEGRITY) qa-role-boundaries.mjs has NEVER tested any role but `guest`,
### and prints a full-role success message anyway.
scripts/qa-role-boundaries.mjs:259  const roles = [{ name: "guest", cookie: null }];
scripts/qa-role-boundaries.mjs:260  for (const [name,email] of Object.entries(JSON.parse(process.env.QA_ROLES ?? "{}")))
NOTHING sets QA_ROLES — not package.json, not any script, not docs/, not CLAUDE.md. grep is empty.
So the loop body never runs and `roles` stays guest-only. Admin is separate and also failed:
    ! could not establish admin: Error: no admin cookie: 500
Both failures are caught and printed as one-line notes, then the run continues and ends with:
    166 probes, 0 findings.
    Every protected route refused every role that should not reach it.
...and exits 0, so `qa:all` proceeds. The sentence is false: the only role probed was a signed-out
guest. Nothing was proven about verified customer, unverified customer, member, ambassador
applicant, approved ambassador, or admin — i.e. every cross-account isolation question the audit
brief asks. This is the evidence behind the repo's "role isolation" claims.

### F-013 (P1, HARNESS/RUNBOOK) `npm run harness:build` before the shim is up bakes an EMPTY catalogue.
Observed: journey harness FAIL "no product links on /products" while the shim served 4 products
correctly at :54321. next build prerenders /products; with no reachable data source at build time
the empty result is baked in (and getCatalogProducts' unstable_cache caches failures too).
CLAUDE.md's ordering (shim, THEN harness:build) is correct and load-bearing, but nothing enforces
it and the failure presents as a product defect ("no products on the site"). My own first run hit it.

### F-014  qa:all run 1 result: qa:roles "passed" (guest-only, see F-012); qa:journey FAILED at
step 1 (catalogue) and step 2 (signup created no auth user) — cascading from F-013, not proven
to be an application defect. qa:purchase and qa:abuse never ran (&& chain). EXIT 1.

## PART 3 — Defects found and fixed this session

### D-001 (P0, ACCOUNT TAKEOVER) — FIXED
Title: the email-change re-authentication ran only in the browser; the server route
       accepted any session and never asked for a password.
Root cause:
  src/components/account-settings-client.tsx said, and meant:
     "// Changing the email is security-sensitive: require the current password
      // first so a hijacked open session can't silently take over the account."
     await supabase.auth.signInWithPassword({ email: initialEmail, password })
  ...then POSTed to /api/account/email-change with ONLY {email}. The route
  (src/app/api/account/email-change/route.ts) called getAuthenticatedUser() and read
  `email`; it never read or verified a password. So the control was a comment.
  Worse, change-password/route.ts:37 asserts parity that did not exist:
     "Same move as signup, password reset, the ambassador invite and the change of email."
Impact: anyone holding the session cookie could
     POST /api/account/email-change {"email":"attacker@..."}
  confirm from their own mailbox, then own the account via password reset. It is worse
  than the password takeover its sibling route closed, because it survives the real
  owner changing their password back — reset mail now goes to the attacker.
Fix:
  route.ts  — read `currentPassword`; 400 if absent (before the limiter, so a typo costs
              no attempts); after the limiter, verify with createServerClient()
              .auth.signInWithPassword({ email: user.email, ... }); 403 on failure.
              Re-auth is against the SESSION's email, never a caller-supplied one.
  client    — stops doing the browser re-auth; sends currentPassword to the server.
Regression test: src/lib/email-change-reauth.test.ts (8 tests).
PROOF IT CATCHES THE DEFECT: run against the pre-fix route (git checkout HEAD -- route.ts),
5 of 8 fail, the headline one with "expected 200 to be 400" — the old route answered a
password-less takeover request with HTTP 200 and minted the link.

### D-002 (P1, REPORTED NOT FIXED — the safe fix is configuration, not code)
The password RESET path applies the new password from the browser.
src/components/account-reset-password-form.tsx:~140
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirmPassword) { ... }
    await supabase.auth.updateUser({ password });      // <- browser, GoTrue direct
There is NO server route that applies a reset password: /api/auth/password-reset only SENDS the
link. So the 8-character minimum on this path is enforced only in the caller's own browser, and a
holder of a recovery session can call GoTrue updateUser directly with whatever the Supabase
project's own minimum allows (6 by default). change-password/route.ts's header names this exact
consequence for the settings path it fixed: "The same call also bypassed the 8-character rule,
leaving whatever minimum the Supabase project happens to be configured with (6 by default)."
The confirmation-match being client-only is FINE — nothing server-side depends on it.

WHY NOT FIXED IN CODE HERE. A new "apply the reset" route would have to authorise on the recovery
access token. A route that accepts any valid access token would let any ordinary signed-in session
set a new password WITHOUT the current one — reopening precisely the hole change-password closed.
Telling a recovery session from an ordinary one needs GoTrue claims the harness shim does not
model, so it cannot be verified here. The correct fix is the project-level one: set the Supabase
Auth minimum password length to 8, which binds EVERY path including updateUser.
OPERATOR ACTION: Supabase dashboard -> Authentication -> Policies -> minimum password length = 8.
Answers audit items 2 (8-char boundary) and 3 (mismatched confirmation).

### D-003 (P2, RECEIPT CORRECTNESS) — FIXED. Answers audit item 7 (discount shown correctly).
src/lib/email/templates.ts orderConfirmationTemplate took a `discount` argument and NEVER READ IT.
Every money line below Shipping came from one residual:
    residual = subtotal + shipping + tax + cardFee - total
    savings  = max(0,  residual)  -> "Discounts & credits"
    addOn    = max(0, -residual)  -> "Shipping protection"
savings and addOn are the two halves of ONE number, so an order with BOTH a discount and an add-on
nets them and prints the difference as the discount. $20 promo + $15 shipping protection nets to
$5: the receipt said "Discounts & credits -$5.00" and showed NO protection line. Not a rounding
error — a different number, on the document customers reconcile against their card statement.
discount_amount is a stored column passed by every caller (payment-webhook.ts:1468, admin/orders,
admin/payments); it was the one figure on the receipt that did not have to be inferred, and it was.
FIX: take the discount out first and show it as itself ("Discount"); the residual keeps its
original job for the parts with no field of their own ("Credits applied" / "Shipping protection").
Lines still sum to Total. A discount exceeding the gross is not believed (it would imply an
impossible add-on) and falls back to the previous residual-only behaviour.
Regression test: src/lib/email/receipt-discount-line.test.ts (6 tests). Against the pre-fix
template 4 fail with "expected undefined to be '-$20.00'".
NOTE ON THE EXISTING TEST: order-confirmation-money.test.ts pinned the LABEL "Discounts & credits".
Its assertions were kept verbatim and only the row name updated — no assertion was weakened or
removed. All 856 email tests pass.

### F-015 (P0, TEST INTEGRITY) qa:purchase skipped 12 of 18 steps and exited 0.
The money path — "a guest buys, pays, and gets ONE receipt" — was never demonstrated.
Skipped: exactly-one-confirmation, retried-webhook-sends-no-second, confirmation page recognises an
authenticated customer, signed-in through checkout and back, guest order claimed at signup,
unconfirmed account cannot claim by naming the address, membership renewal receipt.
CAUSE 1 (documentation): the runbook has TWO env blocks that disagree. Section 5 says
PAYMENT_PROVIDER=mock; a later section says PAYMENT_PROVIDER=live + VEYRA_API_BASE at the local
stub. The first one comes first and is wrong. With mock, /api/checkout/create-session throws
before doing anything, no order is created, and every downstream step skips.
  WHY mock CANNOT WORK: the built chunk is
     function o(e=process.env.PAYMENT_PROVIDER){let t=(e??"").trim().toLowerCase();
       if("mock"===t||"test"===t)throw Error("PAYMENT_PROVIDER=mock/test is forbidden...
  The `if (process.env.NODE_ENV === "production")` branch is CONSTANT-FOLDED AWAY by the bundler,
  so a production build refuses mock unconditionally regardless of runtime NODE_ENV. That is a
  STRONGER control than the source reads and must not be weakened — it just means the harness has
  to use the live provider against scripts/veyra-stub.mjs, which is what the stub exists for.
CAUSE 2 (missing env): PAYMENT_WEBHOOK_SECRET and SHIPPO_WEBHOOK_SECRET absent from the runbook's
env block. Both routes fail CLOSED (correct) so the absence looks like broken settlement/shipping.
CAUSE 3 (harness): the two headline email assertions skip when QA_HARNESS_LOG is unset, and NOTHING
sets it — not the npm script, not qa:all. So the default run gave up on exactly what it exists for.
FIXES: runbook env block corrected and the contradiction called out; .env.test.local uses the live
stub; HARNESS_LOG now defaults to qa-harness-up.sh's own log path; and a run that skips more steps
than it passes now EXITS 1 instead of 0, because a cascade of skips is not a pass.
AFTER: checkout creates real orders again (order-53aa838c..., pending_payment -> paid).

## PART 4 — The 15 previously-ZERO auth/email items, re-measured behaviourally

 #  Item                                          Status  Evidence
 1  Wrong current password refused                PASS    qa:journey §14 "a WRONG current password is refused,
                                                          and nothing changes — 403, password untouched"
 2  8-character minimum boundary                  SPLIT   PASS on the SETTINGS path: qa:journey §14 "enforced
                                                          where the caller cannot reach it — 400", and
                                                          change-password/route.ts:67 server-side.
                                                          UNRESOLVED on the RESET path — see D-002: applied by
                                                          the browser via supabase.auth.updateUser, so GoTrue's
                                                          project minimum (6 by default) is the real floor.
 3  Mismatched confirmation                       N/A     No confirm field on the settings form at all; on the
                                                          reset form it is client-only and NOTHING server-side
                                                          depends on it, which is the acceptable shape.
 4  Post-password-change session behaviour        PASS    qa:journey §14 "signs the account's OTHER devices out";
                                                          §12 "a password reset elsewhere does not silently leave
                                                          a stale session usable"
 5  Verification in another tab / checkout        PASS    qa:purchase §5 "verifying in a second tab does not break
                                                          a checkout in progress"
 6  Original checkout tab notices verification    PASS    qa:purchase §5 "returning to the original tab picks the
                                                          verification up"
 7  Confirmation email discount correct           PASS    FIXED this session (D-003). receipt-discount-line.test.ts
                                                          + order-confirmation-money.test.ts
 8  Confirmation email shipping correct           PASS    order-confirmation-money.test.ts; qa:purchase §2 "the
                                                          order totals on the row are internally consistent —
                                                          76.22 = 59.00 + ship 15.00 + tax 0.00 - disc 0.00"
 9  Malformed signup email rejected               PASS    qa:journey §2 "a malformed email creates no account —
                                                          4 malformed addresses, 0 accounts created"
10  Session survives payment-provider return      PASS    qa:purchase §4 "a signed-in customer stays signed in
                                                          through checkout and back"
11  Actually-expired reset link handled           PASS    qa:journey §3 "an expired link explains itself instead of
                                                          showing a blank form"
12  Profile edits persist after reload            PASS    qa:journey "a profile edit persists across a reload —
                                                          saved and still shown after a reload"
13  Confirmation page recognises signed-in cust.  PASS    qa:purchase §4 "no create-an-account prompt for a
                                                          signed-in customer"
14  Membership renewal/cancellation to right cust PASS*   qa:purchase §6. Was SKIPPING for two separate reasons
                                                          (webhook 500 from the mock-provider guard, then no
                                                          harness log); both fixed. *confirm in the final run.
15  Refresh during send cannot duplicate/lose     PASS    qa:abuse §7, 19/19: "6 aborts across 0–45ms: 6 ran to
                                                          completion despite the disconnect, 0 left nothing
                                                          behind, 0 half-finished"

ZERO-coverage count: 15 -> 0. One item (2) is split: covered on one path, unresolved on the other,
and it is reported as D-002 rather than counted as covered.

## PART 5 — Audit findings I independently RE-CHECKED and DOWNGRADED

### R-001  "Coupon + Buy-3-Get-1 is an unrecoverable checkout dead-end" (reported P0) -> NOT a dead-end.
The workflow's adversarial verifier CONFIRMED this one. It is still overstated, and I am recording
my own reading against it rather than passing it on.
What is true: src/app/checkout/page.tsx:1114 replaces the coupon input with "Buy 3 Get 1 Free is
active — coupons can't be combined with it", and :1151 hides the Remove-code button behind
`couponCode && !isBuy3Get1FreeActive`. So on the checkout screen a customer with an applied coupon
can neither see nor clear it once B3G1 activates. The nearby points panel even instructs "Remove the
code to redeem points" while the control to do so is hidden.
What is NOT true: it is not unrecoverable. src/components/cart-drawer.tsx:514 renders a working
"Remove" for the same coupon via the same clearCouponCode(). The customer can clear it one screen
away. And because B3G1 controls the price, the stranded coupon is inert — no money is mis-charged.
VERDICT: real UX defect (a screen that tells you to do something it has hidden the button for),
P3 not P0, no customer is trapped and no money moves wrongly. Left unfixed; reported.
This is also the answer to question C for this path: annoying, escapable, not a trap.

### D-004 (P1, HARNESS/PRODUCTION SCHEMA DRIFT) — FIXED. Bears directly on question E.
setup-local-harness.sh never applied src/lib/sql/pending-emails-order-link.sql (C-02).
VERIFIED AGAINST PRODUCTION (read-only, project mlpimwgkwuqpsvsrlpqv, 2026-08-30):
  public.pending_emails columns include order_id and email_kind          -> PRESENT in production
  index pending_emails_order_idx (order_id, email_kind) WHERE order_id IS NOT NULL -> PRESENT
  index order_email_log_one_live UNIQUE (order_id, kind) WHERE status IN ('sending','sent') -> PRESENT
The harness had NONE of the pending_emails ones. So production is correct and the HARNESS was a
schema behind — the opposite of an abandoned migration, but just as damaging for evidence.
WHY IT MATTERS: retryPendingEmails detects the missing columns at runtime and falls back to the
legacy query. On that path the sweep sends WITHOUT the idempotency key and never closes the
send-once slot it just satisfied — which is exactly the duplicate-receipt defect C-02 fixed. So any
harness run asserting "a retried webhook does not send a second confirmation" was exercising the
OLD code path, and passing there said nothing about what production runs.
FIX: pending-emails-order-link added to the post-parity migration list, plus three new parity
self-checks (pending_emails.order_id, pending_emails.email_kind, order_email_log_one_live) so the
drift fails loudly instead of silently changing which code path is under test.

GOOD NEWS FOR QUESTION E: exactly-once for order email is DB-ENFORCED in production, not merely
application logic — order_email_log_one_live is a partial UNIQUE index. That is the right shape.

### D-005 (P1, LIVE MONEY LEAK + ROSTER DISCLOSURE) — FIXED. Answers question D.
src/lib/ambassador-status.ts isApprovedAmbassadorCustomer matched by account, THEN by a
caller-supplied email with nothing establishing the caller controlled it. quote-order.ts:661 passes
`input.customer.email` — the checkout form field. At GUEST checkout customerUserId is undefined, so
the email branch was the only one that ran.
REPRODUCTION: guest types an approved ambassador's address at checkout -> gets their personal
discount. Default 20% (admin-control-shared.ts:39). Production (read-only query, project
mlpimwgkwuqpsvsrlpqv): 9 approved ambassadors. Referral programmes publish those addresses.
SECOND HALF: the same branch answered "is this address an ambassador?" to any caller, leaking the
roster even where the discount is withheld.
FIX: the address is read from the ACCOUNT, never the caller. A guest reaches only the account
branch, which without an id does nothing. Reading the account's own address (rather than merely
requiring that an id exist) is what keeps payment-service.ts (authoritative charge) and
/api/account/ambassador-discount (preview) in step — they must agree or the "Altered total
detected" guard fires on a legitimate order.
Regression test: src/lib/ambassador-discount-identity.test.ts (7 tests). 5 fail against the old
implementation; the headline one is "expected true to be false" for a guest who typed the address.
Typecheck clean; 410 tests across quote-order / ambassador / payment-service / referral pass.

### D-006 (P1, DEAD FUNCTION IN A CHECKED-IN MIGRATION) — FIXED.
src/lib/sql/inventory-reservations.sql release_inventory_for_order(text) referenced `batch_limit`,
which is expire_stale_reservations' PARAMETER and is declared nowhere in this function. The `if`
condition is evaluated on every call, so the function raised every time:
    ERROR:  column "batch_limit" does not exist
    CONTEXT: PL/pgSQL function release_inventory_for_order(text) line 27 at IF
Reproduced directly against the harness database. Consequence: no inventory hold is ever released
by it — a failed or cancelled checkout keeps its stock reserved until expire_stale_reservations
happens past it. Every existence/grant check in the file passed the whole time.
PRODUCTION IS NOT AFFECTED (read-only check, pg_proc.prosrc for release_inventory_for_order
contains no "batch_limit"). The hazard was the FILE: deploy-run-once re-applies it, which would
have installed the broken copy over the working one.
FIX: the stray warning block removed (there is no batch to page through when releasing one order's
holds). Re-applied and verified: `select public.release_inventory_for_order('no-such-order')` now
returns 0. Added a parity self-check that CALLS the function rather than checking it exists —
every existence check passed while it was dead.

### D-007 (P2, HARNESS ISOLATION) — FIXED. This is the answer to question G.
qa-abuse-and-roles.mjs never isolated its client IP: all 10 browser contexts used the default
address, while the file's entire section 1 exists to EXHAUST the per-IP signup/reset/resend
buckets. journey and purchase were given CSPRNG addresses for exactly this reason; the file that
actually spends the buckets was left on the shared one, which is the wrong way round.
FIX: same CSPRNG CGNAT address the other two use, applied through a single newContext() helper so
no context can silently fall back.

## PART 6 — RLS, verified against PRODUCTION read-only (project mlpimwgkwuqpsvsrlpqv)

83 of 83 public tables have rowsecurity = true. NONE without.
Most carry ZERO policies, which in Postgres is DENY-ALL for anon/authenticated — the safe default.
The app reads through the service role (BYPASSRLS), so RLS is defence in depth here and the
behavioural cross-account probes are the primary evidence. Every policy that DOES exist on a
customer-data table is owner-scoped:
  customer_addresses_owner          ALL     user_id = current_auth_uid()
  customer_preferences_owner        ALL     user_id = current_auth_uid()
  customer_memberships_select_own   SELECT  user_id = current_auth_uid()
  orders_select_own                 SELECT  lower(customer_email) = current_auth_email()
  order_items_select_own            SELECT  via the parent order's customer_email
  partners_select_owner_or_admin    SELECT  auth_user_id = current_auth_uid() OR role = 'admin'
  orders/order_items/partners _update_admin, _insert_admin  -> admin only
No permissive/anon-readable policy on any customer-data table. Nothing to fix.
NOTE: the audit's claim that "rls_auto_enable() ships without its CREATE EVENT TRIGGER, so RLS
auto-enablement does not exist in any database" is true of the SQL file, but the OUTCOME it warns
about does not exist: every production table already has RLS on. Worth fixing for new tables;
not a live exposure.

## PART 7 — Caveat on the parallel audit's own numbers

The workflow reported 89 findings across 10 dimensions; adversarial verification confirmed 61 and
refuted 28. Those counts are NOT clean, and the reason matters:

THE VERIFICATION PASS RAN AGAINST A MOVING TREE. I was fixing defects in the same working copy
while the verifiers were reading it. So several "refutations" are the verifier correctly reading
code I had ALREADY FIXED, not a finding that was never real. Confirmed cases:
  - "Email change performs its re-authentication only in the browser" -> refuted as "the reporter
    read a stale copy". The reporter was right; I had committed the fix (3c8d76c) before the
    verifier looked.
  - "qa-role-boundaries.mjs probes only the guest role by default" -> refuted because the verifier
    found the fixed file (7a031ac) and read my new comment describing the bug as historical.
  - "Every email-change QA step omits currentPassword" -> refuted; I had already updated those
    steps (534a3fd).
So "refuted" here means one of two different things and the count cannot be read as "28 were
wrong". Everything I report as a defect below was verified BY ME against the code, not taken from
the workflow's verdict.

CONVERSELY, one CONFIRMED finding I re-checked and DOWNGRADED myself: R-001, the coupon +
Buy-3-Get-1 "unrecoverable dead-end", which is escapable from the cart drawer.

The lesson for the next session: run the verification pass against a FROZEN commit, not a working
tree being edited.

### D-008 (P2, VACUOUS ASSERTION) — FIXED. A direct answer to question F.
src/lib/shipping-protection-default.test.ts asserted
    expect(source).toContain("useState(false)")
against the whole of cart-context.tsx, which contains TEN of them; nine are unrelated state. So
the test named "the cart does not pre-select shipping protection" passed on any boolean in the
file starting false — including with the shipping-protection state deleted outright, or its
default moved behind a variable. The negative guard beside it was real but matched only the exact
literal `useState(true)`.
FIX: match the ONE declaration and read its initial value out of the match.
PROOF: flipping the default to true now fails with "shipping protection is pre-selected, which the
Shipping Policy says it is not". Before the change that mutation was invisible.

### F-016 (P2, PROCESS FOOTGUN I HIT MYSELF) — DOCUMENTED.
`npm run build` and `npm run harness:build` share .next, and the harness server keeps serving
whatever is there. A production build is NODE_ENV=production, so Next does not read
.env.test.local — the server returns with no Supabase URL, no payment provider, no webhook
secrets. The failures then land nowhere near the build: sign-in stops setting a session cookie,
the account page bounces to login, a refresh "signs the customer out", the cart "drops the
session". I produced exactly that false regression by running the certification build in the same
sitting as the browser tests — which is precisely when both get run.
Runbook now says to run the production build LAST, and qa-harness-up.sh checks the CATALOGUE
rather than a 200 on the home page, so it surfaces at bring-up instead of minutes later.

### F-017 (P1, LIVE — DUPLICATE EMAILS HAVE ALREADY HAPPENED IN PRODUCTION). Answers question E.
Reported by the audit, verified by me against the live database (read-only).
email_send_log has NO unique constraint — only a PK on id and four non-unique indexes:
  email_send_log_pkey (id), idx_email_send_log_reference, idx_email_send_log_campaign_type,
  idx_email_send_log_recipient, idx_email_send_log_campaign_status
So the marketing/automation "send once" guard is a read-then-write with nothing behind it. Order
emails ARE protected (order_email_log_one_live, partial UNIQUE) — automations are not.

IT HAS ALREADY FIRED:
  campaign_type              recipient              sends  first_sent               last_sent
  automation:post_purchase   btunchi88@gmail.com        3   2026-08-28 01:01:44.969  ...45.562
Three sends inside 600 MILLISECONDS. That is not a legitimate repeat; it is concurrent writers each
reading "not sent" and all three sending. (The cart_recovery_* duplicates in the same query span
days and are plausibly separate carts, so they are not evidence of the race.)
MITIGATING: every duplicate is to the OWNER's own address — no customer has received a duplicate
automation yet. The mechanism is live regardless.
NOT FIXED HERE, deliberately: adding a unique index to a production table that already contains
duplicate rows fails on creation, so it needs a de-duplication migration written and rehearsed
against a copy first. That is a change to make deliberately, not at the end of an audit session.
RECOMMENDED: partial unique index on (campaign_type, recipient_email) for the automation:* types,
after de-duplicating; or move automations onto the order_email_log claim pattern that already works.

### D-009 (P2, VACUOUS ASSERTION) — FIXED. Another direct answer to question F.
qa-purchase-path.mjs "the confirmation quotes the customer's own order number" reported
`quotes VL-XXXX` in two situations where it had established nothing:
  1. With no harness log it fell back to `const log = ... : ""`, and `"".includes(x)` is false, so
     `assert(!quotedRaw)` held while inspecting an empty string.
  2. Even WITH a log it only checked the raw `order-<uuid>` key was ABSENT — never that the
     customer's own number was PRESENT. A subject with no order reference, or somebody else's,
     passed.
FIX: skip (not pass) when there is no log; assert the positive as well as the negative.

### D-010 (P2, REGRESSION I INTRODUCED AND THEN FIXED) — worth recording honestly.
Giving qa-abuse-and-roles.mjs its own client IP (D-007) broke two of its steps, because of HOW the
override was expressed. Both steps deliberately present a DIFFERENT address from the rest of the
run (section 1 floods the signup and resend limiters and they need an unspent bucket), and both did
it with X-Real-IP on the fetch inside page.evaluate. Playwright applies a context's
extraHTTPHeaders in the NETWORK LAYER, where they override anything page script sets — so those
headers were silently discarded the moment the context grew one.
Symptoms, both of which read as product defects:
    FAIL  a customer who lost the email can always get another one
          resend answered 429 for an address with no account
    PASS  aborting the signup request mid-flight ... 0 ran to completion despite the disconnect,
          6 left nothing behind        <- six requests that never reached the handler, recorded as
                                          six clean aborts. "No account was created" is a
                                          legitimate outcome of that test, which is precisely why a
                                          throttled run passes it having exercised nothing.
FIX: the override happens in a context of its own, on a fresh CSPRNG address, navigated to the site
first (/api/auth refuses a request with no Origin). The fixed TEST-NET addresses went too — unique
per step but identical across runs, the same collision one level up.
AFTER: 19/19, 0 skipped, and the ladder reports 4 of 6 reaching completion rather than 0.
LESSON: this is the second time in this session that a harness change made a step pass or fail for
a reason unrelated to the product. Both were caught only because the step's DETAIL string carried
the numbers ("0 ran to completion"), not just PASS. Detail strings are load-bearing.
