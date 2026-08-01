# Deploying Vanta Labs to Vercel

Plain-English steps to put the site live. Do these in order. You only do
steps 1–4 once; after that, every `git push` redeploys automatically.

---

## 1. Run the database migrations (Supabase)

Supabase Dashboard → **SQL Editor** → **New query** → paste the **entire**
contents of **one** file → **Run**. Expect “Success. No rows returned.”

- `src/lib/sql/deploy-run-once.sql`

That single file bundles everything the app needs (all tables, columns,
indexes, and functions), built entirely from idempotent statements
(`create ... if not exists`, `create or replace function`). It is safe on a
fresh **or** an existing database, safe to re-run, and never drops or
overwrites your data. It now also includes **CHUNK 4 — security hardening**
(the admin 6-digit passcode columns and deny-by-default Row Level Security on
every table). If you deployed before this was added, just re-run the file.

After running it, verify RLS is on everywhere (should return **zero rows**):

```sql
select tablename from pg_tables where schemaname = 'public' and rowsecurity = false;
```

---

## 2. Import the project into Vercel

1. Go to **vercel.com** → sign in with **GitHub**.
2. **Add New → Project**.
3. Find **vanta-labs** → **Import**.
4. **Root Directory**: click **Edit** and set it to **`website`**
   (the Next.js app lives in the `website/` folder, not the repo root).
5. Framework preset should auto-detect **Next.js**. Leave build settings default.

---

## 3. Add Environment Variables (during import, before clicking Deploy)

Open the **Environment Variables** section and add each of these. The two
`NEXT_PUBLIC_` values are safe/public; the **service-role key is secret** —
paste your current one, never share it.

| Name | Value |
|------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://mlpimwgkwuqpsvsrlpqv.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `sb_publishable_ce7MbWp2UROBThI9c8CXLQ_iU9ZCsVT` |
| `SUPABASE_SERVICE_ROLE_KEY` | *(your current secret key — paste it, don't commit it)* |
| `NEXT_PUBLIC_SITE_URL` | `https://your-domain.com` (or the Vercel URL for now) |
| `CRON_SECRET` | *(any long random string you make up)* |

**Admin login code (second step):** after this is deployed, set your 6-digit
login code from **Admin → My Account → 6-digit login code**. No environment
variable needed. Until you set one, login works with just username + password,
so you're never locked out.

**`CRON_SECRET`** protects the scheduled job at `/api/cron/sweep` (membership
billing + abandoned-cart emails), which `vercel.json` runs every 30 minutes.
Vercel Cron automatically sends this value as `Authorization: Bearer …`; if
it's unset, the job returns 401 and those tasks never run. Any long random
string works.

Everything else (payment processor, email, 3PL) is optional and stays safely
off until you fill it in later — see `.env.example` for the full list.

---

## 4. Deploy

Click **Deploy** and wait a couple minutes. When it finishes you'll get a
live URL. Open it and check the homepage loads.

---

## 5. After it's live

- **Publish your products** from the admin so they show on the storefront.
- **Enter your payment handles** (Cash App / Zelle / PayPal) in the admin —
  manual checkout goes live the moment they're filled in.
- **Set `NEXT_PUBLIC_SITE_URL`** to your real domain (Vercel → Settings →
  Environment Variables) so emails and the sitemap use the right links, then
  redeploy.

---

## 6. Turning on Apple Pay express checkout (optional)

The mini-cart's Apple Pay button is off by default. It is a real one-tap
payment path, so every item below must be done **in this order** — skipping
any one of them produces a button that opens a sheet and then fails.

1. **Run the migration first.** SQL Editor → paste
   `src/lib/sql/express-checkout.sql` → Run, then run the verification query
   at the bottom of that file. Every column must come back `t`. Deploying the
   code before the tables exist means the express endpoints fail while money is
   in flight.
2. **Register the serving host for Apple Pay** with the wallet tokenization
   provider, and confirm
   `https://<host>/.well-known/apple-developer-merchantid-domain-association`
   serves **200 with no redirect**. Check the host the browser actually lands
   on — if the apex redirects to `www`, `www` is the one that matters, and the
   two are separate registrations.
3. **Set the environment variables** (Vercel → Settings → Environment
   Variables), all of them, then redeploy:

   | Name | Value |
   |------|-------|
   | `VEYRA_API_BASE` | your processor's API base |
   | `VEYRA_SECRET_KEY` | your processor's secret key |
   | `PAYMENT_WEBHOOK_SECRET` | the signing secret from the processor's webhook endpoint |
   | `CHECKOUT_ENABLED` | `true` |
   | `NEXT_PUBLIC_SITE_URL` | the exact public origin, e.g. `https://www.your-domain.com` |
   | `VEYRA_SHIPPING_CALLBACK_TOKEN` | any long random string you make up |
   | `NEXT_PUBLIC_APPLE_PAY_DOMAINS` | the registered host(s), comma-separated |

4. **Point a webhook** at `https://<host>/api/webhooks/payment`, subscribed to
   the payment success / failure / refund / dispute events, and put its signing
   secret in `PAYMENT_WEBHOOK_SECRET`. The signed webhook — not the browser —
   is what marks an order paid. Without it, cards are charged and orders sit
   unpaid until the reconciliation sweep catches them.
5. **Prove the ordinary card lane end to end first**: one real order that goes
   session → charge → webhook → `payment_status = 'paid'`. Every settlement
   assumption on the express lane rests on that path working.
6. Only then set `NEXT_PUBLIC_EXPRESS_CHECKOUT_ENABLED=true` and redeploy.
7. **Test on a real iPhone.** None of this is verifiable on a desktop browser.
   Check that the button appears only after all three confirmations are ticked,
   that changing the address in the sheet updates **both** shipping and tax,
   that shipping protection and the service fee each appear as their own row,
   and that an address outside the US/Canada is refused rather than quoted $0
   shipping.

---

## Updating later

Any change pushed to your production branch redeploys automatically. To change
a key or setting, edit it in **Vercel → Settings → Environment Variables**,
then **Deployments → ⋯ → Redeploy**.
