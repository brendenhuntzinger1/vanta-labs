# Order push notifications — setup runbook

"You just got an order" on the operator's phone. One POST per **paid** order,
never on an abandoned or failed checkout.

The application half is built, tested and merged. The two steps below are the
only things standing between a paid order and your phone, and **both require a
logged-in browser** — they cannot be scripted from this repo, because one is a
production secret and the other is a Zapier account action.

Until both are done, a paid order sends nothing and records an
`order_push_not_configured` warning on `/admin/status`.

---

## Step 1 — Build the Zap (do this first; step 2 needs its URL)

1. Zapier → **Create** → **Zaps**.
2. **Trigger:** app `Webhooks by Zapier`, event **Catch Hook**. Do not add a
   child key. Continue.
3. Copy the **webhook URL** it shows you. It looks like
   `https://hooks.zapier.com/hooks/catch/12345678/abcdefg/`. This is the value
   for step 2 — keep the tab open.
4. **Action:** app `Pushover`, event **Send Notification**. Pick the Pushover
   account already connected to this Zapier account.
5. Map the fields — these names come straight from the payload:

   | Pushover field | Map to |
   | -------------- | ------ |
   | Title          | `title` |
   | Message        | `message` |
   | URL            | `url` |
   | URL Title      | *(type)* `Open order in admin` |

   Leave Priority at Normal. Everything else can stay default.
6. **Publish the Zap.**

> **Publishing is not optional and its absence is invisible.** A Zapier catch
> hook answers `200` the instant it receives a request, before any step runs.
> An unpublished Zap therefore accepts every order and discards it, and the
> store cannot tell that apart from a successful delivery — it will record the
> notification as sent. If alerts are silent but `/admin/status` is clean, an
> unpublished Zap is the first thing to check.

## Step 2 — Set the secret in Vercel

1. Vercel → project **vanta-labs** → **Settings** → **Environment Variables**.
2. Add `ORDER_PUSH_WEBHOOK_URL` with the catch-hook URL from step 1.
3. Tick **Production**. Preview and Development are optional — a preview deploy
   that shares the variable will ring your phone for test orders.
4. **Redeploy.** Environment variables are read by the running function, so an
   existing deployment does not pick up a new value.

Treat the URL like a password. Never prefix it `NEXT_PUBLIC_`, and never commit
it: it is the only thing authenticating the alert, so anyone holding it can fire
fake "you got an order" notifications at your phone. `https://` only — an
`http://` URL is refused rather than sent in the clear.

## Step 3 — Confirm it works

Place a £1/$1 test order through checkout, or approve a manual payment. Within a
few seconds you should get:

```
New Order VL-1042
Jordan Mitchell — $89.00
2× Alpha Peptide 10mg, 1× Bac Water 30ml
profit $41.20 (est.)
Aug 26, 2026, 2:42 PM ET
```

If nothing arrives, check in this order:

| Symptom | Cause |
| ------- | ----- |
| `order_push_not_configured` on `/admin/status` | Step 2 not done, or done without a redeploy |
| `order_push_misconfigured` on `/admin/status` | The URL is not `https://` |
| `order_push_failed` on `/admin/status` | Zapier refused or timed out; the detail names the status |
| Status page clean, phone silent | The Zap is unpublished, or its Pushover step is failing — check **Zap history** in Zapier |

---

## What is actually sent

Flat JSON, strings only, so any automation platform maps it without a parsing
step:

```
event, title, message, order_number, order_id, customer, total, profit,
profit_status, item_count, items, url, placed_at, placed_at_display
```

- `title` carries the order number — a phone shows the title first and in bold.
- `message` is the whole body, pre-assembled, one fact per line. Use it as-is.
- `total` and `profit` are unformatted numbers, so a Zap filter can compare them
  ("only alert above $200"). The currency symbols live in `message`.
- `placed_at` is the machine-readable UTC instant; `placed_at_display` is the
  same moment in the store's zone (`America/New_York`), which is what a human
  should read. Vercel runs UTC, so an unpinned format reports a 9pm Eastern
  order as having happened tomorrow.

### What is deliberately absent

The customer's **full name** is sent. Their **email address, phone number and
shipping address are not**, and there is nowhere in the payload to put them.
Both `order-push-notification.test.ts` and the e2e suite assert their absence.

That is a real boundary, not an oversight: this payload comes to rest in two
third-party systems outside our control — Zapier's task history and Pushover's
message log — neither of which any privacy policy here covers, and neither of
which forgets. Adding a field should be a decision someone makes on purpose.

## What this is not

Delivery is **best-effort**: no retry, no queue, no delivery guarantee. It never
throws and never blocks, because it runs immediately after money has changed
hands and a dead webhook must never disturb a paid order. If Zapier is down for
the eight-second timeout, that one alert is gone — you will get a warning on
`/admin/status`, but no re-send.

`/admin/orders` remains the authoritative record of what was ordered. Nothing
downstream may depend on a notification having been sent.
