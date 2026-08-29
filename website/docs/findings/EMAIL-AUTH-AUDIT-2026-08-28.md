# Email, Login & Account-Recovery Audit — 2026-08-28

**Scope:** transactional email delivery, customer login, forgot/reset password,
affiliate (ambassador) sign-in, and application/signup email verification.

**Method:**

- Static read of every `sendEmail()` call site, all 41 exported templates, the
  provider layer, the retry queue, suppression, middleware and the four auth
  surfaces.
- Local harness per `BROWSER-TESTING-RUNBOOK.md` — Postgres 16 + `pgrst-shim` +
  `gotrue-shim`, production build (`harness:build` / `harness:start`), driven
  with Chromium over Playwright MCP at desktop and 390×844.
- Production Supabase **read-only** via MCP: `auth.users`,
  `auth.one_time_tokens`, `admin_control_current`, `notification_queue`,
  `pending_emails`, `email_send_log`, `ambassadors`.
- Sentry, 30-day window.
- Full gate: `vitest run` → **5472 passed / 106 skipped / 0 failed**.

**No production state was changed.** No test orders, no account creation, no
emails sent, no writes of any kind.

## Evidence grades

| Grade | Meaning |
|---|---|
| `BROWSER-PROVEN` | Reproduced in Chromium against the local harness. |
| `PROD-DATA` | Established from production rows read via Supabase MCP. |
| `CODE` | Established by reading the tree; no runtime proof. |
| `NOT VERIFIED` | Named explicitly — the harness cannot reach it. |

The gotrue shim documents itself as **not implementing email confirmation, OTP
or password reset**. Every claim that depends on a real Supabase Auth email is
therefore graded `NOT VERIFIED`, and is flagged as such rather than inferred.

---

## 1. Findings

### E1 — Password reset and email verification never touch this codebase
**Severity: High · CODE + PROD-DATA · Type: operational blindness + false documentation**

`passwordResetTemplate` (`src/lib/email/templates.ts:150`) and
`emailVerificationTemplate` (`:126`) have **zero production call sites**. Scanning
all 41 exported templates against the tree (excluding their own definition file
and tests) returns exactly six unused, and those two are among them.

Both emails are sent by **Supabase Auth (GoTrue)** — its SMTP, its default
templates, its From address. `supabase.auth.resetPasswordForEmail()` and
`supabase.auth.signUp()` are the only triggers, and neither passes through
`sendEmail()`.

`src/lib/email/settings.ts:14-22` asserts the opposite:

> EVERY transactional email in the app (order confirmation, payment received,
> payment approved/rejected, shipping updates, **password resets, account
> verification**, ambassador notifications, etc.) flows through the same
> `sendEmail()` and starts delivering automatically.

The admin UI repeats it — `admin-settings-client.tsx:353` describes the From
address as "the domain that sends receipts **and password resets**".

**Consequence.** Production is configured (verified live) as provider `resend`,
`from = orders@vantalabsresearch.com`, `enabled = true`. That configuration
governs receipts, shipping and ambassador mail. It does **not** govern the two
emails a locked-out user depends on. Those come from a second sending identity
configured only in the Supabase dashboard, which means:

- the bounce/complaint webhook (`/api/webhooks/email`) never sees an auth-email
  bounce, so a hard-bouncing address on the reset path is invisible;
- the branded `renderLayout` template never renders for either email;
- an operator who fixes email in Admin → Settings has not fixed password reset.

**Fix.** Either state the split plainly in `settings.ts` and the admin hint, or
route both through `sendEmail()` using GoTrue's `generateLink` admin API so one
provider and one reputation carry all customer mail.

---

### E2 — The reset-password recovery check is client-side and self-forgeable
**Severity: Medium-High · BROWSER-PROVEN**

`src/components/account-reset-password-form.tsx:26`:

```js
const looksLikeRecoveryLink = hash.includes("type=recovery") || hash.includes("access_token=");
```

The comment above it claims a security property:

> only a genuine PASSWORD RECOVERY session may change the password here without
> re-entering the current one … accepting that would let anyone with a hijacked
> open session silently reset the owner's password.

**Reproduction (harness, Chromium):**

1. Signed up and signed in normally → live session in `localStorage`.
2. `GET /account/reset-password` with no fragment → correctly rejected:
   *"This reset link is invalid or has expired."* The guard works for the
   accidental case.
3. Read the session out of `localStorage` and built a fragment from those same
   tokens: `#access_token=…&refresh_token=…&expires_in=3600&token_type=bearer&type=recovery`.
4. Loaded `/account/reset-password` with that fragment (a real navigation — a
   hash-only `goto` is same-document and does not re-run the effect, which will
   fool a careless retest).
5. **"Choose a new password" rendered.** Submitted a new password; no
   current-password prompt; redirected to `/account`.
6. `auth.users.encrypted_password` for that user changed to the new value.

No recovery email, no Supabase-issued recovery token — only tokens the browser
already held.

**Fair framing.** An attacker holding those tokens could call
`supabase.auth.updateUser({ password })` from the console directly; this page was
never the security boundary. The defect is that a comment asserts a guarantee the
code does not provide, and the guarantee is load-bearing in review.

Note the contrast: `account-settings-client.tsx:115-117` re-authenticates with
`signInWithPassword` before `updateUser({ password })`. The reset page is the
only path that skips re-auth, and its substitute guard does not hold.

**Fix.** Gate strictly on the `PASSWORD_RECOVERY` event (already subscribed at
`:30`) rather than on a string in the fragment, and enable GoTrue's *secure
password change* (require recent re-authentication) at the project level. Then
correct the comment to describe what is actually enforced.

---

### E3 — `/login` is a live, orphaned affiliate sign-in with no recovery path and no CAPTCHA
**Severity: High for the affected user · BROWSER-PROVEN**

`src/app/login/page.tsx` renders `PartnerLoginForm`. The build emits `ƒ /login`.
Browser-confirmed: **"Partner Portal — Secure Login"**, containing exactly an
email field, a password field and a Sign In button.

What it lacks, all of which `/account/login` has:

| Affordance | `/account/login` | `/login` |
|---|---|---|
| Forgot your password? | ✅ | ❌ |
| Resend confirmation email | ✅ | ❌ |
| Turnstile CAPTCHA token | ✅ | ❌ |
| Remember-me choice | ✅ | ❌ (defaults to a 30-day cookie) |

An affiliate who reaches this page and cannot sign in **has no way out of it.**

The CAPTCHA gap is the same latent failure the forgot-password form was recently
hardened against: `partner-login-form.tsx:22-25` calls `signInWithPassword` with
no `captchaToken`. Turnstile is currently unconfigured, so it is dormant — but
the moment a secret is set in the Supabase dashboard, GoTrue starts rejecting
tokenless calls and this page breaks for every user, with no code change to point
at.

It also contradicts its own sibling. `/partner/login` redirects to
`/account/login` with the comment *"Ambassadors are ordinary customer accounts,
so there is no separate partner login."* `/login`'s copy — *"Use your approved
partner credentials"* — implies credentials that do not exist.

Nothing in the tree links to `/login` (grep: zero references). It is reachable
only by bookmark or an old link — which is precisely the returning-affiliate
case it fails.

**Fix.** Redirect `/login` → `/account/login` exactly as `/partner/login` does,
and delete `PartnerLoginForm`.

---

### E4 — Ambassador email has no retry and no failure signal; 5 production rows are stranded
**Severity: High · CODE + PROD-DATA**

The durable retry queue (`enqueueFailedEmail`) is wired into three places:
`payment-webhook.ts`, `shippo/service.ts`, `api/admin/orders/[orderId]`. It is
**not** wired into `partner-portal.ts`, so no ambassador email is ever retried.

Three separate gaps compound:

1. **The failure is unobservable.** `createPartnerApplication`
   (`partner-portal.ts:733-735`) awaits `sendEmail` and discards the result
   inside a `try/catch`. `sendEmail` is documented to *never throw* — it returns
   `{ success: false }` — so the catch is dead code and a failed
   "application received" email leaves no trace at all.

2. **A failed owner alert is recorded as sent.** `:755` sends the alert without
   checking the result, then `:762-766` marks the `notification_queue` row
   `status = 'sent'` unconditionally. The admin's pending-notification count
   reports work as handled that never happened.

3. **The retry workflow does not exist.** On approval-email failure the code
   keeps the queue row pending — *"Keep pending queue row for retry workflows"*
   (`:1991`). Nothing anywhere reads `notification_queue`: grep finds no consumer
   outside `partner-portal.ts`, and the cron sweep's `emailRetry` job drains
   `pending_emails` only.

**Production evidence** (`notification_queue`, read live):

| kind | status | count | oldest | newest |
|---|---|---|---|---|
| `partner_application_approved` | sent | 21 | 2026-07-21 | 2026-08-27 |
| `partner_application_received` | sent | 8 | 2026-07-25 | 2026-08-27 |
| **`partner_application_received`** | **pending** | **4** | **2026-07-21** | **2026-07-23** |
| `partner_application_rejected` | sent | 3 | 2026-07-21 | 2026-07-21 |
| **`partner_application_rejected`** | **pending** | **1** | **2026-07-20** | **2026-07-20** |

Five rows have sat pending for over a month. `pending_emails` is empty, so they
were never migrated to the queue that *is* drained.

Sentry over 30 days shows nine issues, **none** email- or auth-related — which is
consistent with these failures being swallowed rather than absent.

**Fix.** Check `result.success` in `partner-portal.ts` and call
`enqueueFailedEmail` on failure, as the order paths do; stop marking the queue
row sent on an unchecked send; either give `notification_queue` a sweep consumer
or drop the comment that promises one.

---

### E5 — Marketing and transactional mail share one sending domain
**Severity: Medium · PROD-DATA**

Live `admin_control` (`target_table = 'email'`):

```
enabled                  true
provider                 resend
from                     orders@vantalabsresearch.com
marketing_from           ""          ← empty
marketing_postal_address (set — CAN-SPAM satisfied)
```

`marketing_from` empty means `resolveMarketingFrom()` falls back to the
transactional address. Cart recovery — four emails per abandoned cart, the
highest-volume promotional mail the store sends — goes out from the same domain
as receipts.

`settings.ts:52-66` explains exactly why that is a risk, and the admin field
carries the right hint. The field is simply unset. This is an operator action,
not a code defect. CAN-SPAM compliance is fine.

---

### E6 — Password recovery has never completed in production
**Severity: Medium · PROD-DATA + NOT VERIFIED**

Across all 23 production accounts, exactly **one** has ever had
`recovery_sent_at` (2026-07-26, the owner's own). `auth.one_time_tokens` still
holds that `recovery_token` **unspent**, a month later.

One attempt, zero completions, in the site's entire history. There is no
end-to-end evidence the reset path works for a real user, and the harness cannot
supply it (the gotrue shim does not implement password reset).

**The single config most likely to break it silently cannot be read from SQL and
is not in this repo:** Supabase → Authentication → URL Configuration → Redirect
URLs must contain `https://www.vantalabsresearch.com/account/reset-password`.
The app sends the right value — the harness confirmed the outgoing call carries
`redirect_to=…/account/reset-password`, correctly derived from
`NEXT_PUBLIC_SITE_URL` — but if GoTrue does not have that URL allowlisted it
falls back to the site root and drops the user on the home page with the tokens
in the fragment and no form in sight.

**Action:** verify that allowlist entry by hand, then run one real reset against
a mailbox you control.

---

### E7 — Signup confirmations are being lost, with a Yahoo-shaped signal
**Severity: Medium · PROD-DATA**

3 of 23 accounts are unconfirmed; all three have `confirmation_sent_at` set and
`last_sign_in_at` null, and three unspent `confirmation_token`s remain.

Two of the three are informative:

- **`sch***@yahoo.com`** signed up 2026-08-27 02:15:03 and never confirmed.
  **`sch***@gmail.com` signed up 30 seconds later (02:15:33) and confirmed in
  10 seconds.** The same person switching mailbox providers after the first link
  did not arrive — a Yahoo-specific deliverability signal on the auth sender,
  which is exactly the sender nothing in this app monitors (see E1).
- **`ger***@gmail.com`** (2026-08-28, today): `created_at 17:52:16`,
  `confirmation_sent_at 17:56:53` — a **4m37s** gap where every other account's
  gap is ~50ms. That is a *resend*, not the original send. Still unconfirmed.

A third, **`zai***@gmail.com`**, carries `user_metadata.role = "partner"` and
never confirmed: an ambassador applicant who never got in.

The mitigations already in the tree are good and should stay:
`handleResendConfirmation` uses the supported, enumeration-safe
`supabase.auth.resend`, and `auth-signup-outcome.ts` fixed the copy that used to
promise a link to returning users who would never receive one.

What is missing is **visibility** — nothing alerts on an account left unconfirmed
past a threshold, so this is only ever found by reading `auth.users` by hand.

---

## 2. Lower-severity items

| # | Finding | Where |
|---|---|---|
| E8 | `/api/partner/apply` echoes raw `error.message` to the client, while `/api/auth/session` and `/api/contact` sanitise via `customerSafeMessage`. Can leak Postgres relation/column names. | `api/partner/apply/route.ts:58-60` |
| E9 | `/api/contact` returns the provider's own error text (e.g. `Resend API error (401): …`) to an anonymous submitter, two lines above a correctly sanitised catch. | `api/contact/route.ts:91-95` |
| E10 | Forgot-password page has no link back to sign-in — a dead end for anyone who lands there by mistake. Confirmed at 390×844. | `account-forgot-password-form.tsx` |
| E11 | `/api/auth` is absent from the middleware CSRF prefix list (`/api/admin`, `/api/account`, `/api/membership`, `/api/partner`). `SameSite=Lax` blocks the cookie from being set on a cross-site POST, so this is defense-in-depth, not a live hole — but it is the one auth endpoint outside the list. | `middleware.ts` |
| E12 | Four further templates are dead code: `membershipTrialConfirmation`, `membershipBenefitsMonthly`, `membershipBirthday`, `newProductLaunch`. | `lib/email/templates.ts` |
| E13 | Maintenance mode locks out password recovery — `pathBypassesMaintenance` covers `/api/unsubscribe` and `/api/coa` but not `/account/forgot-password` or `/account/reset-password`. Probably intended; worth making a conscious decision. | `middleware.ts` |

---

## 3. What is working, and should not be "fixed"

- **Account enumeration is genuinely closed.** Signup, resend and reset all
  return identical outcomes for known and unknown addresses.
  `resolveSignupOutcome` deliberately refuses to read `data.user.identities`
  even though it could, and documents why. Browser-confirmed: an address with
  no account gets the same "if an account exists…" message.
- **Role escalation is closed.** `detectRoleFromUser` honours `admin` **only**
  from `app_metadata` (service-role-only), so a customer cannot self-promote via
  `updateUser({ data: { role: "admin" } })`. Production confirms no account
  carries an `app_metadata.role` at all.
- **The SMTP provider treats an empty `accepted[]` as failure**, not success —
  the nodemailer trap where a 550 resolves rather than rejects is handled.
- **The bounce/complaint webhook is well built**: constant-time secret compare,
  pure parser separated from the writes, 5xx returned only when a suppression
  write actually failed, and nothing from the payload logged.
- **Suppression carve-out is correct.** `email_suppressions` gates marketing
  only; transactional mail is never suppressed, which is the right side of the
  CAN-SPAM line.
- **CAN-SPAM postal address is applied at the wrapper**, so a template added
  tomorrow is compliant without its author knowing the rule.
- **Order email send-once** (`order_email_log` + Resend `Idempotency-Key`) is
  sound, including releasing the slot on failure and re-closing it on retry.

---

## 4. Coverage limits

Not established by this audit, and not inferred:

- Real GoTrue email delivery, and the genuine recovery-token round trip — the
  gotrue shim implements neither. `NOT VERIFIED`.
- Turnstile behaviour under a configured secret — unconfigured everywhere today.
- RLS policy correctness — the shim connects as superuser.
- Whether Supabase's Redirect-URL allowlist contains the reset path (E6). This
  is the highest-value single manual check to come out of this audit.

---

## 5. Suggested order of work

1. **E6** — check the Supabase redirect allowlist and run one real password
   reset. Five minutes; unblocks the only recovery path a locked-out customer
   has, and it has never been proven to work.
2. **E3** — redirect `/login` to `/account/login`. One line; removes a
   recovery-less affiliate dead end and a CAPTCHA time bomb.
3. **E4** — check `sendEmail` results in `partner-portal.ts` and enqueue
   failures. Restores a signal that is currently absent.
4. **E1** — correct the documentation, or unify the sending path.
5. **E2** — gate on `PASSWORD_RECOVERY`, enable secure password change, fix the
   comment.
6. **E5, E7** — set `marketing_from`; add an unconfirmed-account alert.
