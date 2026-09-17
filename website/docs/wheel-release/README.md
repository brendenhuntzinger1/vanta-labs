# The minimum wheel release

**Question this answers:** can the spin-to-win invitation go to a live list
without shipping the SMS signup work or the Omnisend migration, both of which
are unreviewed and unapproved?

**Answer: yes, and it is proven rather than argued.**

`minimum-wheel-release.patch` is a 36-file change against `origin/main`. It was
built in a scratch worktree from `origin/main`, and there:

| check | result |
|---|---|
| `git apply --check` against a fresh `origin/main` | clean |
| `tsc --noEmit` | clean |
| `next build` (NODE_ENV=test) | exit 0 |
| `npm test -- --run` | **10,414 passed, 0 failed**, 266 skipped |
| files matching sms / omnisend / welcome-offer-copy / invite-modal | **0** |

The image the email uses, `public/images/spin-wheel-hero.png`, is excluded from
the patch only because a binary blob makes it unreadable in review. It is
already committed on `claude/zealous-johnson-atb3n5` and must travel with it.

## Why this was not obvious

The working branch is **179 files** ahead of `main` and contains two unrelated
bodies of work: the wheel, and the whole Omnisend/SMS system (roughly 25
modules under `src/lib/marketing/omnisend/`, plus the signup UI). None of that
is on `main` at all. Shipping the branch as it stands would deploy the entire
SMS system — dark, but deployed.

The wheel's own modules turned out to import nothing from it. Only three shared
files needed care:

- **`admin-control.ts`** genuinely mixed. Its diff is two clean hunks — the
  wheel config at line 666, the SMS signup config at 891. Only the first is
  here; `getSmsSignupConfig` is absent from this release.
- **`customer-offers.ts`** carried the welcome vial catalogue entry
  (`welcome_free_ghkcu`). Removed: nothing in this tree mints it.
- **`coupons.ts`** surfaces the existing `coupons.source` column through the
  validation result. Verified against production — the column exists. It is
  structural, not SMS.

`welcome-offer-terms.ts` IS included, because `quote-order.ts` imports it. It is
a pure constants module with no I/O; `WELCOME_GIFT_ENABLED` is `false` and the
coupon sources it names (`omnisend_welcome`, `welcome_offer`) match no coupon
that exists in production today. It is inert, and it is the only file here whose
name mentions the welcome offer.

## What must happen in production before a single email goes out

Nothing in this release sends anything by itself. Four deliberate steps, in
order:

1. **Deploy the code.** The wheel is off at this point — `getSpinWheelConfig`
   defaults `enabled: false`, and `/spin` returns 404 while it is off.
2. **Apply `src/lib/sql/spin-percent-cap.sql`.** Adds a nullable
   `max_discount_cents` to `customer_offers`. Additive; existing rows are
   unaffected. Without it the percentage wedges are uncapped.
3. **Turn the wheel on** — Control store, section `spin_wheel`:
   `enabled = true`, `campaignId = <a new id for this campaign>`.
   Until this is set, the email's CTA does not personalise: `attachSpinLink`
   returns the destination unchanged when the wheel is off, so every recipient
   would land on a 404. **This is the step that must not be forgotten.**
4. **Create the campaign and schedule it.** A row in `email_campaigns` with
   `status = 'draft'` sends to nobody, however often the sweep runs — verified.
   Moving it to `status = 'scheduled'` with a `scheduled_at` is what arms it;
   `/api/cron/lifecycle` promotes it to `sending` once that time passes.

### Rollback

Set `spin_wheel.enabled = false`. The page 404s and `/api/spin` 404s
immediately; no deploy is needed. Prizes already won stay in `customer_offers`
and stay redeemable, which is the correct behaviour — a customer who won
something should not lose it because the promotion was paused. To stop those
too, revoke the rows (`revoked_at`), which the checkout already honours.

The SQL column is additive and needs no rollback.

## What this release deliberately does NOT contain

- Any SMS signup prompt, consent text, or `sms_subscribers` write.
- Any Omnisend contact sync, flow, template or migration.
- The admin wheel campaign builder. The wheel is configured through the control
  store (two keys) and the campaign through the existing Admin → Email
  composer. A reusable builder is still to come.
- `benefitChoice` is present in `quote-order.ts` but unreachable in this
  release: it only engages when a welcome-code coupon sits beside a wheel
  prize, and no welcome-code coupon exists in production.
