# Deployment handoff

Everything here was checked against the live database on 2026-09-17, read-only.
Where an earlier document said "apply the two SQL files", it was wrong; the
detail below replaces it.

## 1. What production already has

| Object | State | Consequence |
| --- | --- | --- |
| `customer_preferences.sms_marketing`, `sms_consent_at`, `sms_opted_out_at`, `phone` | present | `customer-sms-consent.sql` is already applied. Nothing to do. |
| `sms_subscribers` table | **present, 0 rows, and NOT the shape this branch first assumed** | see below |
| `omnisend_events_sent`, `omnisend_sync_state`, `omnisend_consent_snapshot` | absent | `omnisend-sync.sql` is outstanding |
| `coupons.assigned_email` | present | the welcome code binds to it |

### The `sms_subscribers` trap

Production's table is keyed on `phone_e164` and carries `status`,
`marketing_consent`, `disclosure_version`, `opt_out_keyword`,
`resubscribed_at`, `resubscribe_count` and verification columns. It is a better
table than the one this branch originally described, and the application now
writes it.

The original `sms-subscribers.sql` said `create table if not exists`. Applying
it would have **done nothing, reported success, and left every consent write
failing** on columns that do not exist — silently, because the consent writer
catches its own errors. A customer would tick the box, be told they were
subscribed, and have nothing recorded. That file is now additive only.

## 2. The SQL to run, in order

Run as the service role, against production. Both are safe to run twice and
neither writes a row.

```
website/src/lib/sql/omnisend-sync.sql       -- creates 3 tables; not yet applied
website/src/lib/sql/sms-subscribers.sql     -- adds sms_subscribers.email + an index
```

Verify afterwards:

```sql
select
  (select count(*) from information_schema.tables where table_name = 'omnisend_events_sent') as events_sent,
  (select count(*) from information_schema.tables where table_name = 'omnisend_sync_state') as sync_state,
  (select count(*) from information_schema.tables where table_name = 'omnisend_consent_snapshot') as consent_snapshot,
  (select count(*) from information_schema.columns
     where table_name = 'sms_subscribers' and column_name = 'email') as sms_email_column;
```

All four must read 1. If `sms_email_column` is 0, the app cannot tie a number
to an address and no welcome code will be minted.

## 3. Environment

| Variable | Where | Value | Effect if unset |
| --- | --- | --- | --- |
| `OMNISEND_API_KEY` | Vercel, production | the account's API key | every Omnisend call is skipped; the store runs exactly as it does today |
| `OMNISEND_MARKETING_OWNER` | Vercel, production | `true` **only at cutover** | in-house marketing keeps sending; Omnisend flows stand down |

Both are read at request time, so a redeploy is needed after setting the key.
Neither belongs in any other environment: the sync is gated to production, and
a preview with the key set would push real contacts.

## 4. Admin settings (no deploy needed)

Stored as control rows, changeable without shipping code.

| Setting | Default | Meaning |
| --- | --- | --- |
| `sms_signup.prompts_enabled` | `false` | Every customer-facing SMS incentive: the invitation, the catalogue bar, the product link, the cart card, the checkout discount line. The plain consent boxes are unaffected. |
| `sms_signup.dismiss_cooldown_days` | `7` | How long a dismissed invitation stays dismissed on a device. |
| `sms_signup.holdout_percent` | `0` | Share of eligible shoppers deliberately shown nothing, so the offer's effect can be measured against a control. |

## 5. Order of operations

1. Apply the two SQL files. Verify with the query in §2.
2. Set `OMNISEND_API_KEY` and redeploy. Nothing changes for customers: every
   flow is disabled, the ownership switch is off and prompts are off.
3. Run the sync dry run from the admin route and read the counts. No contact is
   pushed on a dry run.
4. Import contacts, then verify counts in Omnisend against the store.
5. Set `OMNISEND_MARKETING_OWNER=true` and redeploy. In-house marketing stands
   down; Omnisend owns marketing from here.
6. Enable flows one at a time, welcome and welcome-offer together.
7. **Only once a subscriber can actually be texted** — carrier approval
   confirmed and a test message received — set `sms_signup.prompts_enabled` to
   true. Suggested order: the checkout line first, then the quiet placements,
   then the invitation.
8. If measuring, set `holdout_percent` to 10 at the same moment as step 7, not
   later: a holdout started midway compares two different periods.

## 6. Rollback

Every step reverses without data loss, and none of them widens consent.

| Symptom | Action | Effect |
| --- | --- | --- |
| Prompts look wrong, or texts cannot be sent yet | set `sms_signup.prompts_enabled` to `false` | every incentive disappears within a request. Consent already recorded is kept; codes already issued stay valid |
| Omnisend sending badly | set `OMNISEND_MARKETING_OWNER=false`, redeploy | in-house marketing resumes immediately; Omnisend flows stand down. Contacts and consent remain |
| Omnisend integration misbehaving at all | unset `OMNISEND_API_KEY`, redeploy | every Omnisend call is skipped. The store behaves as it did before this branch |
| A bad flow already sending | disable that flow in Omnisend | takes effect for new entrants at once |
| Schema doubt | none needed | both files are additive; nothing is dropped and no column is altered |

Nothing in the rollback path deletes a consent row or re-subscribes anybody. An
opt-out survives every step above, which is the one direction that must never
reverse.

## 7. Measuring whether the offer earned anything

Comparing subscribers with non-subscribers cannot answer this: people who join
a text list were already more interested and would convert better with no offer
at all. Use the holdout.

With `holdout_percent` at 10, held-back shoppers are chosen by a stable hash of
their address, so the same person is always on the same side. The split is
reproducible in SQL without this application:

```sql
select (('x' || substr(md5(lower(customer_email)), 1, 8))::bit(32)::bigint % 100) < 10
         as held_back,
       count(*) filter (where payment_status in ('paid', 'succeeded', 'captured')) as orders,
       count(distinct customer_email) as people
from orders
group by 1;
```

Read first-order rate per group, not revenue per subscriber. Give it enough
first orders to be decisive before concluding anything; at a dozen orders a
month, that is months, not weeks.
