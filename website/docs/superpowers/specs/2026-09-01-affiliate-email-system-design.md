# Affiliate Email System — design

Date: 2026-09-01
Status: approved (owner decisions recorded below)

## The shape of the problem

The owner asked for a way to email affiliates from the admin: mass sends,
hand-picked sends, personalisation, preview, test send, drafts, scheduling,
duplicate-send protection, history, and a competitions feature that tracks
qualifying sales and locks a winner.

Almost none of that is new machinery. **This store already has a campaign
system**, built for customers, and it already solves the hard parts:

| Requirement | Already exists |
|---|---|
| Batched, resumable sending | `email_campaign_recipients` claim queue, `campaign-sender.ts` |
| Duplicate-send protection | `unique (campaign_id, email)` — re-queuing cannot double-send |
| Drafts / schedule / test send | `/api/admin/email/campaigns/[id]/send`, modes `now` / `schedule` / `test` |
| Opens, clicks, bounces, history | `email_campaign_clicks`, `email_send_log`, `getEmailDashboard` |
| Unsubscribe + CAN-SPAM address | `sendMarketingEmail` |
| Reputation separation from receipts | `resolveMarketingFrom` |
| "Which orders genuinely qualify" | `qualifiesForMonthlyTierCount` (`ambassador-commission.ts`) |

So the design is **an extension of the existing campaign system, not a second
one beside it.** A parallel affiliate mailer would mean a second queue, a second
suppression check and a second history — three chances for affiliate mail to
drift out of step with the compliance rules that took this codebase a long time
to get right.

What is genuinely missing is four things:

1. an affiliate audience (approved ambassadors, all or hand-picked);
2. per-recipient personalisation — every campaign today renders one identical body;
3. competitions, with progress tracking and a winner that cannot be won twice;
4. history filtered to affiliate campaigns.

## Owner decisions

**Consent — no opt-in gate.** Affiliates are business partners; requiring them
to appear in the *customer* marketing store (`customer_preferences.marketing_emails`
/ `marketing_subscribers`) would silently shrink "Send to all affiliates" to
whichever affiliates happened to tick a customer marketing box. So the audience
is built from `ambassadors` directly.

The unsubscribe link and `List-Unsubscribe` header stay, because affiliate
campaigns still route through `sendMarketingEmail`. Three reasons: the original
brief asked for unsubscribe/preferences; 15 U.S.C. § 7704 requires an opt-out
and a postal address on commercial mail regardless of the recipient's
relationship; and Gmail/Yahoo have scored bulk mail without `List-Unsubscribe`
worse since February 2024. Routing around the one wrapper that owns all three
would be building a deliberate hole in the compliance layer.

An affiliate who unsubscribes lands in `email_suppressions` and stops receiving
**promotional** mail only. Approval, commission, payout and account email are
transactional, use `sendEmail` directly, and are untouched by any of this.

**Competitions — track and lock, never pay.** The system counts qualifying
sales, shows exactly which orders counted, and locks the winner atomically so a
bonus cannot be awarded twice. It records no payout: the owner reviews the
qualifying orders and pays manually.

## Architecture

### 1. Schema (`src/lib/sql/affiliate-email-system.sql`)

Additive and idempotent, in the house style.

`email_campaigns` gains:

- `audience_kind text not null default 'customer'` — `customer` | `affiliate`.
  Defaulted so every existing row keeps its current meaning, and so the customer
  composer needs no change.
- `affiliate_filter text` — `all_active` | `selected`.
- `affiliate_ids uuid[]` — the hand-picked set when `selected`.

`email_campaign_recipients` gains:

- `ambassador_id uuid` — who this recipient is, for personalisation.
- `merge_context jsonb` — **a snapshot of the merge values taken at queue time.**

  The snapshot is the important decision. Commission percent and referral code
  can change between the moment the owner presses Send and the moment the sweep
  reaches row 4,000. Resolving merge values per batch would mean two affiliates
  receiving materially different claims about their own rate from one campaign,
  and would make the preview a lie. It also turns N per-recipient lookups into
  one read at queue time.

New table `affiliate_competitions` — name, window, `sales_required`,
`bonus_amount`, participant scope, status, and the winner columns
(`winner_ambassador_id`, `won_at`, `winning_order_id`).

RLS enabled with no policies (deny-by-default for anon/authenticated), matching
every other admin-only table here.

### 2. Merge variables (`src/lib/email/affiliate-merge.ts`)

Pure and testable, no database.

`{{first_name}}`, `{{affiliate_code}}`, `{{referral_link}}`,
`{{commission_percent}}`, `{{dashboard_link}}`.

Two rules that matter:

- **Unknown variables are rejected at compose time**, not silently left in the
  body. `{{firstname}}` reaching a real affiliate as literal text is the failure
  mode, and the composer is the only place it can still be fixed.
- **Substitution happens before `campaignTemplate`**, which escapes the body. So
  a merge value cannot inject markup — it goes through the same `escapeHtml`
  every other campaign body does.

Missing first name falls back to a neutral greeting rather than rendering an
empty space after "Hey ".

### 3. Affiliate audience (`src/lib/email/affiliate-audience.ts`)

Approved ambassadors, optionally narrowed to a hand-picked set, **minus
`email_suppressions`** — subtracted up front for the same reason the customer
audience does it: so the count the owner sees before pressing Send is the truth
rather than an overestimate that quietly shrinks.

Deduped by email, so two ambassador rows sharing an address receive one message.
Reads are bounded (`readAllRowsBounded`) and a truncated read is fatal, matching
`audience.ts`.

### 4. Sending

`queueCampaign` branches on `audience_kind` and writes `ambassador_id` +
`merge_context`; `sendCampaignBatch` applies the merge per recipient. Everything
else — claiming, the reaper, the time budget, retries, suppression, the
unsubscribe footer — is unchanged and shared.

**Double-click protection** gets one addition. The unique constraint already
makes a second send harmless at the recipient level, but the status guard is
read-then-write and two simultaneous clicks both see `draft`. A conditional
status claim (`update ... where status in ('draft','scheduled','paused')`,
matching the claim pattern already used for recipient rows) makes the second
click return a clean 409 instead of appearing to succeed.

### 5. Competitions (`src/lib/affiliate-competitions.ts`)

**The qualifying rule is not rewritten.** `qualifiesForMonthlyTierCount` already
encodes what this store means by a genuine sale — it excludes `reversed`,
`voided` and `manual_review` commissions, zero-commission and ineligible orders,
and fraud-flagged self-dealing. Refunds reach it correctly: a full refund sets
`reversed` (or `manual_review` if the commission was already paid), and free
replacement reships carry no commission so they are excluded already.

That predicate is split into its window-independent half so competitions and the
monthly tier count share one definition. A competition that counted differently
from the commission engine would be the worst possible bug here — it would pay a
bonus on sales the store does not consider real.

**Winner locking is a conditional update**, not a read-then-write:

    update affiliate_competitions set winner_ambassador_id = $1 ...
    where id = $2 and winner_ambassador_id is null

Zero rows updated means someone else already won. Two affiliates crossing the
threshold in the same sweep cannot both be recorded.

### 6. Admin UI

Two new tabs on `/admin/partners` (which is where affiliates live, and reads as
Admin → Affiliates → Email Affiliates). The tab entries are a small addition to
`admin-partners-client.tsx`; all real logic lives in two new focused components
so that file does not grow another thousand lines.

Confirmation before a mass send is a modal naming the exact recipient count.

## Testing

Unit: merge rendering and validation, audience resolution and suppression
subtraction, competition counting against refunded / cancelled / replacement /
fraud-flagged orders, winner-lock concurrency, double-send claim.

Regression: the existing suite, particularly the email and ambassador files,
must stay green — the whole point is that transactional mail is untouched.

Browser: the local harness per `website/docs/BROWSER-TESTING-RUNBOOK.md`, at
desktop and 390x844.
