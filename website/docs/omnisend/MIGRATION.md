# Contact migration: snapshot, push, report, cutoff, rollback

Companion to `OPERATIONS.md` (the operator's manual once Omnisend owns
marketing) and `CHECKLIST.md` (state of the work). This file is the record of
how the store's contacts reach Omnisend, how the migration is checked, and how
it is undone. Everything here describes the code as it is in
`src/lib/marketing/omnisend/`; where the code and this file disagree, the code
and its tests are right and this file needs fixing.

Nothing in this file names a person, an address or a key. Nothing described
here enables a flow or sends a message.

## 1. The field map

One contact per address. The store gathers the facts in `contacts.ts`
(`collectContactFacts`), the pure builder in `contact-payload.ts`
(`buildContactPayload`) turns them into the Omnisend payload, and the push in
`reconcile.ts` sends them in batches of 100 through `POST /batches`
(`endpoint: contacts`, `method: POST`). Every address is lowercased before it
leaves: Omnisend email identifiers are case-sensitive and the store's are not.

| Store (table.column) | `ContactFacts` field | Omnisend field |
| --- | --- | --- |
| `marketing_subscribers.email`, the account's auth email, or `orders.customer_email` (whichever put the address in the population) | `email` | `identifiers[type=email].id` |
| `email_suppressions` row present | `emailConsent.status = unsubscribed`, `changedAt = email_suppressions.created_at` | `identifiers[email].channels.email.status`, `.statusChangedAt` |
| `marketing_subscribers.unsubscribed_at` is null (active guest opt-in) | `emailConsent.status = subscribed`, `changedAt = opted_in_at`, `source = marketing_subscribers.source` | `channels.email.status`, `.statusChangedAt`, `consent.source`, `consent.createdAt` |
| `customer_preferences.marketing_emails = true` | `emailConsent.status = subscribed`, `changedAt = customer_preferences.updated_at`, `source = account-settings` | same as above |
| `marketing_subscribers.unsubscribed_at` set, no account opt-in | `emailConsent.status = unsubscribed`, `changedAt = unsubscribed_at` | `channels.email.status`, `.statusChangedAt` |
| none of the above (known from an order or account only) | `emailConsent.status = nonSubscribed`, `changedAt = now` | `channels.email.status`, `.statusChangedAt` |
| `customer_preferences.phone` | `phone` | `identifiers[type=phone].id`, E.164 (only when an SMS consent record exists, see below) |
| `customer_preferences.sms_marketing = true` and a phone on file | `smsConsent.status = subscribed`, `changedAt = sms_consent_at`, else `updated_at`, else `now`; `source = account-settings` | `identifiers[phone].channels.sms.status`, `.statusChangedAt`, `consent.source`, `consent.createdAt` |
| `customer_preferences.sms_opted_out_at` set | `smsConsent.status = unsubscribed`, `changedAt = sms_opted_out_at` | `channels.sms.status`, `.statusChangedAt` (no `consent` block) |
| `orders.customer_name` of the latest paid product order, else the account's full name | `firstName`, `lastName` (split on the first space) | `firstName`, `lastName` (omitted when blank) |
| `orders.country`, `.state`, `.city`, `.postal_code` of the latest paid product order | `countryCode`, `state`, `city`, `postalCode` | `countryCode` (default `US`), `state`, `city`, `postalCode` |
| paid product orders for the address (`PAID_ORDER_STATUSES`, `isProductPurchaseOrder`) | `orders`, `totalSpent`, `firstOrderAt`, `lastOrderAt` | tag `customer` when `orders > 0`; `customProperties.vl_orders`, `vl_total_spent`, `vl_first_order_at`, `vl_last_order_at` (dates in the store's display zone) |
| recipient attestation (`recipientHasAttested`) | `attested` | tag `attested`; `customProperties.vl_attested` |
| `customer_preferences.referral_code` | `referralCode` | `customProperties.vl_referral_code` |
| a link token signed at push time (`signOmnisendLink`, 30 days) | `link.token`, `link.endsAt` | `customProperties.vl_link`, `vl_link_ends` |
| `coupons` rows with `assigned_email` and source `omnisend_welcome`, `omnisend_winback`, `omnisend_recovery`, live and unspent | `codes.welcome`, `codes.winback`, `codes.recovery` | `customProperties.vl_welcome_code`, `vl_welcome_ends`, `vl_welcome_ready`, and the same three for `winback` and `recovery` |
| always | — | tag `source: website`; `identifiers[email].sendWelcomeMessage = false` |

### The consent status and timestamp rules, exactly as `contact-payload.ts` and `contacts.ts` implement them

Email, in order of precedence (`emailConsentFrom`):

1. If the suppression store could not be read, the status is `unsubscribed`
   with `statusChangedAt = now`. Not knowing whether a person unsubscribed is
   treated as knowing that they did.
2. A suppression row wins over everything: `unsubscribed`, `statusChangedAt =
   email_suppressions.created_at` (or `now` if the row has none).
3. Either consent store makes the address `subscribed`. The guest opt-in is
   consulted first: `statusChangedAt = marketing_subscribers.opted_in_at`
   and `consent.source = marketing_subscribers.source`; when only the account
   toggle is set, `statusChangedAt = customer_preferences.updated_at` and
   `consent.source = account-settings`. `consent.createdAt` is always the same
   instant as `statusChangedAt`.
4. A guest opt-out with no account opt-in is `unsubscribed`, `statusChangedAt =
   marketing_subscribers.unsubscribed_at`.
5. Otherwise `nonSubscribed`, `statusChangedAt = now`.

SMS (`smsConsentFrom`): the account box with a number on file is
`subscribed`, `statusChangedAt = sms_consent_at`, falling back to
`updated_at`, then `now`, `consent.source = account-settings`. An opt-out stamp
is `unsubscribed`, `statusChangedAt = sms_opted_out_at`. Anything else is no
SMS record at all. A phone identifier is only ever sent alongside an SMS
record: a number typed into account settings with the box untouched never
leaves the store, and a phone number given at checkout is never read.

The `consent { source, createdAt }` block is attached only to a status
somebody chose, which in practice means `subscribed`. `nonSubscribed` and
`unsubscribed` carry a status and a timestamp and nothing else.

### Deliberately not mapped

These stay in the store and never reach Omnisend as contact data:

- `orders.phone`. A checkout phone number is not SMS consent.
- `email_suppressions.reason`. The snapshot records it (section 2); Omnisend
  sees only `unsubscribed`.
- The IP address at consent. Omnisend accepts `consent.ip`; the store does not
  send it.
- Anything about the account beyond the fields above: password state, sign-in
  history, admin notes, wholesale and ambassador flags, memberships, gift
  tokens, the in-house cart recovery stage, and the shipping addresses of any
  order but the latest.
- Order rows themselves. Orders reach Omnisend as events (`placed order`,
  `paid for order`, and so on), through a different path with its own ledger.
- An account with SMS consent but neither email consent nor a paid order. The
  push population is the consented audience plus paid buyers, so such an
  account is not visited until it joins one of the two.

## 2. The operator sequence

All four calls go to `POST /api/admin/omnisend/sync` with an admin session
whose role may manage email campaigns. Every result is JSON; nothing in it
names an address.

1. **Snapshot.** `{ "what": "snapshot" }`, or `{ "what": "snapshot", "label":
   "..." }` to name it. The default label is `pre-migration-<UTC date>`. The
   job records, for every address the push will visit and every address on
   the suppression list, what the store says at that instant: email status,
   SMS status, whether a phone is on file, the consent sources, the
   suppression reason, the paid order count and the last order date. Rows are
   written in chunks of 500 to `omnisend_consent_snapshot`, and the label and
   instant are recorded on the `migration` row of `omnisend_sync_state`. A
   label that already has rows is skipped, not appended to; the result says
   so. Check that `result.rows` equals `result.addresses`; a shortfall is in
   `result.skipped`.
2. **Contacts, dry run.** `{ "what": "contacts", "dryRun": true }`. Reads
   Omnisend and the store, writes nothing anywhere, and returns the report
   (section 3) with `push.submitted` and `push.batches` set to what WOULD go
   out. Read the report before going on.
3. **Contacts, live.** `{ "what": "contacts" }`. On the first live run the
   `migration` row gets `cutoffAt`, the instant this push began, and it is
   never moved by a later run. The batches go out, their ids come back in
   `report.push.batchIds` and are remembered under the `batches` row of
   `omnisend_sync_state`. Omnisend processes them in the background, so
   `report.unresolved` will say that N batches were submitted and the next
   run polls them.
4. **Next run.** Every later run, from the nightly cron or the same button,
   polls each remembered batch that has not reached `finished` or `stopped`
   and folds the answer into `report.unresolved`. An empty `unresolved` on
   the second run means every batch finished with no item errors.
5. **Later snapshot, optionally.** `{ "what": "snapshot", "label":
   "post-migration-<date>" }`, then the comparison in section 6. This is the
   proof that the migration widened nothing.

After the cutoff the daily reconcile carries the delta. It has two halves,
in this order: the write-back pages `GET /contacts?updatedAtFrom=<watermark>`
and mirrors Omnisend unsubscribes, SMS opt-outs and form sign-ups into the
store, then the push re-collects every address in the population from the
store's own records and re-sends it. The watermark is the
`contacts_reconcile` row's `updatedAtFrom`, the newest `updatedAt` among the
contacts read; it advances only after a pass that read every page and
applied every write, and is otherwise held so the same contacts are re-read
tomorrow. The push has no watermark on purpose: it is a full re-send, so a
store record that changed after the cutoff is on the contact by the next
night whatever happened to the batch that first carried it.

## 3. The reconciliation report

`reconcileOmnisendContacts` returns `report` alongside the existing counters.
Every value is a count, a boolean or a batch id.

| Field | What it counts |
| --- | --- |
| `store.consented` | The consented audience at the start of the run: both consent stores, minus suppressions and provider sink addresses. This is the set pushed as `subscribed`. |
| `store.buyersWithoutConsent` | Paid product buyers outside that audience. Pushed as `nonSubscribed`, for segments and lifetime value only. `consented + buyersWithoutConsent` is the push population. |
| `store.suppressed` | Rows on `email_suppressions`. These are not pushed by the reconcile; they go back as `unsubscribed` only when they are also buyers. Zero when the list could not be read, and `unresolved` says so. |
| `store.smsConsented` | Contacts walked this run whose account carries SMS consent with a number on file. Counted over the population, so a capped or time-limited run undercounts and `unresolved` says why. |
| `store.nonMailable` | Buyer addresses dropped because they are provider sinks or otherwise non-mailable. The audience loader drops its own before this job sees them. |
| `omnisend.contactsBefore` | Omnisend's contact count before this run changed anything, by paging `GET /contacts` at 250 a page. |
| `omnisend.contactsAfter` | The same count after a live push. A batch still processing is not in it yet; the next run's `contactsBefore` is the settled number. Equal to `contactsBefore` on a dry run or when nothing was posted. |
| `omnisend.capped` | True when either count stopped at the 40-page ceiling (10,000 contacts) and is therefore a floor, not a total. |
| `push.submitted` | Contacts handed to Omnisend this run, or that would have been on a dry run. |
| `push.batches` | Batches accepted (`POST /batches` answered 2xx), or that would have been posted. |
| `push.batchIds` | The `batchID` of each accepted batch, in order. Empty on a dry run. |
| `push.failedBatches` | Batches Omnisend refused outright. Their contacts are re-sent by the next run. |
| `writeBack.suppressed`, `.smsOptOuts`, `.formSubscribers` | Store rows written from Omnisend's changes (or planned, on a dry run). |
| `unresolved` | One line per thing the run could not settle. See below. |

How to read it. The population that should be in Omnisend is
`store.consented + store.buyersWithoutConsent`. On a first live run
`omnisend.contactsAfter - omnisend.contactsBefore` should approach that number
once the batches finish, less any contacts Omnisend already had from a form or
an earlier run, less `push.failedBatches` worth of contacts. A gap that does not
close by the next run is in `unresolved`.

`unresolved` lines and what to do about them:

- `N batch(es) submitted; ...the next run polls them`: expected on every live
  run that pushed. Run again tomorrow, or now.
- `batch <id> not finished (pending|inProgress|unknown)`: Omnisend is still
  working, or the poll could not reach it. Run again.
- `batch <id> finished with N item error(s) of M`: Omnisend rejected N items.
  Read `GET /batches/<id>/items` for the per-item reason (a contact payload
  it would not accept, usually a phone number it could not parse). The next
  run re-sends the same contacts; if the count does not fall, the record
  itself needs looking at. The line stays until the batch ages out of the
  last fifty remembered.
- `batch <id> stopped after N of M items, K item error(s)`: Omnisend halted
  the batch. Same as above.
- `N batch(es) failed`: the POST itself was refused. The contacts are re-sent
  next run; a persistent refusal is a transport or key problem, in the log
  under `[omnisend/reconcile]`.
- `push capped: N target(s) left for the next run` and `time budget reached
  after N contacts`: the population is larger than one run carries. The
  consented audience is pushed first, so what is left is buyers without
  consent. Run again.
- `omnisend contact count capped at 40 pages` and `omnisend contact count
  incomplete`: the before and after numbers are floors.
- `write-back skipped: suppression list unreadable` and `consented audience
  unreadable; nothing pushed`: the store could not be read in full, so
  nothing was written on a guess. Look at the database before running again.
- `N write-back write(s) refused; watermark held`: a store write failed. The
  watermark did not move, so the same contacts are re-read next run.

## 4. The invariants

**The store never widens consent on the strength of Omnisend.** The
write-back (`planWriteBack`, pure and tested) may make the store's record
smaller (an Omnisend unsubscribe becomes a suppression, an SMS opt-out becomes
an opt-out stamp) or add a consent the store never heard about (a sign-up
through Omnisend's own form becomes a guest subscriber row), but it never
re-opens a consent the store has closed: a suppressed address stays suppressed
whatever status Omnisend holds, whoever set it there. The push then re-reads
consent from the store's own records, so an address suppressed in the store
goes back to Omnisend as `unsubscribed` the same night. A checkout phone
number is never SMS consent, and SMS consent is only ever granted in account
settings; the write-back records SMS opt-outs and ignores SMS subscribes.

**An API-created `subscribed` contact CAN trigger an Omnisend welcome
automation.** `sendWelcomeMessage: false` on every identifier turns off
Omnisend's own built-in welcome mail. It does not stop a custom automation
whose trigger is "subscribed to marketing": if such a flow is enabled when
the import runs, every subscribed contact in the batch enters it and is
mailed. So the order is fixed: import first, verify the report and the
Omnisend contact list, and only then enable flows, one at a time, starting
with the ones whose trigger cannot have fired retroactively. The account is
built with every automation disabled for exactly this reason. The same
applies to event batches, which this migration does not send.

**Every write is idempotent.** A contact pushed twice is the same contact
(same identifier, `POST` merges on it); a snapshot label taken twice is one
snapshot; the cutoff is written once; the watermark only advances.

## 5. Rollback

1. Unset `OMNISEND_MARKETING_OWNER` in Vercel (or set it to anything but
   `true`). On the next lifecycle tick the in-house cart recovery ladder,
   automations and campaigns resume; the admin campaign send endpoint stops
   refusing. Disable the Omnisend flows in the Omnisend dashboard so the two
   systems never mail the same inbox on the same day.
2. There is no consent to restore. The migration copied consent from the
   store to Omnisend and never the other way except to shrink it (section 4),
   so the store's record after rollback is the store's record before it, plus
   any unsubscribes and form sign-ups that happened in the meantime, which are
   real and stay.
3. Prove it. Take a later snapshot (`{ "what": "snapshot", "label":
   "post-migration-<date>" }`) and run section 6 against the pre-migration
   label. An empty result is the proof.
4. `OMNISEND_API_KEY` can stay set: with the owner flag off, contacts, consent,
   catalogue and events keep flowing to Omnisend and nothing sends. Unset it
   too if the account is being abandoned; every hook then returns at the gate.

## 6. The comparison

One statement. It lists every address whose email or SMS status was anything
but `subscribed` under the earlier label and is `subscribed` under the later
one. Replace the two labels; the pre-migration one is on the `migration` row
of `omnisend_sync_state` as `snapshotLabel` if it was the last snapshot taken.
Run it with the service role (the table has no policies). The expected result
is no rows; a row is a consent that widened between the two snapshots, and
each one needs an explanation from the store's own records (a person who
re-subscribed through the site or the account toggle is legitimate; anything
else is a defect).

```sql
select later.email,
       earlier.email_status as email_before, later.email_status as email_after,
       earlier.sms_status   as sms_before,   later.sms_status   as sms_after,
       earlier.suppressed_reason
from public.omnisend_consent_snapshot as earlier
join public.omnisend_consent_snapshot as later
  on later.email = earlier.email
where earlier.label = 'pre-migration-YYYY-MM-DD'
  and later.label   = 'post-migration-YYYY-MM-DD'
  and (
       (earlier.email_status <> 'subscribed' and later.email_status = 'subscribed')
    or (earlier.sms_status   <> 'subscribed' and later.sms_status   = 'subscribed')
  )
order by later.email;
```

Addresses present under the later label but not the earlier one are new
since the cutoff (form sign-ups, new buyers) and are not widening; addresses
present only under the earlier one were deleted from the store, which no job
here does.

## 7. Where the pieces are

| Piece | File |
| --- | --- |
| Facts and consent precedence | `src/lib/marketing/omnisend/contacts.ts` |
| Payload and field names (pure, tested) | `src/lib/marketing/omnisend/contact-payload.ts` |
| Write-back rule, batch bookkeeping, report shape, labels (pure, tested) | `src/lib/marketing/omnisend/reconcile-plan.ts` |
| Reconcile: write-back, push, count, poll, cutoff | `src/lib/marketing/omnisend/reconcile.ts` |
| Snapshot | `src/lib/marketing/omnisend/migration-snapshot.ts` |
| `migration` and `batches` rows of `omnisend_sync_state` | `src/lib/marketing/omnisend/migration-state.ts` |
| Admin route | `src/app/api/admin/omnisend/sync/route.ts` |
| Tables | `src/lib/sql/omnisend-sync.sql` (pending in `supabase-schema-parity.test.ts` until applied to production) |
