# Vanta Labs — Staging Setup (test the whole store with fake money)

This gets you a **staging** environment where the full site runs against a real
(but throwaway) database and the **sandbox payment gateway**, so every flow —
signup, checkout, coupons, memberships, ambassadors, refunds — can be clicked
end to end **without a real payment processor and without charging any card**.

You do this once. It takes ~20 minutes and costs $0 (all free tiers). When your
real high-risk processor is approved later, you flip two env vars — no code
changes (see the last section).

> Production deploy is a separate doc (`DEPLOY.md`). Keep staging and production
> as **separate Supabase projects** so test orders never touch real data.

---

## What you'll create (3 accounts, all free)

1. **A staging Supabase project** — the database + auth.
2. **A host to run the app** — Vercel (free) is easiest; or run locally.
3. **A test email inbox** — to see verification/order/shipping emails. Options:
   a free [Resend](https://resend.com) account (100 emails/day), OR a
   [Mailtrap](https://mailtrap.io) sandbox inbox (catches mail without
   delivering). Either works.

You do **not** need a payment processor for staging — the sandbox gateway stands
in for it.

---

## Step 1 — Create the staging Supabase project

1. [supabase.com](https://supabase.com) → **New project**. Name it
   `vanta-labs-staging`. Pick any region and a strong database password.
2. When it finishes provisioning, open **SQL Editor → New query**.
3. Paste the **entire** contents of `src/lib/sql/deploy-run-once.sql` → **Run**.
   Expect *"Success. No rows returned."* (If it errors on length, run the
   `CHUNK 1/2/3` sections in the file one at a time.)
4. Then run these seed/support files the same way (SQL Editor → paste → Run):
   - `src/lib/sql/membership-tiers-seed.sql` (membership tiers)
   - `staging-seed.sql` *(created for you — see Step 5; test products with
     COAs/costs, a coupon, and an ambassador so there's something to click)*
5. Verify RLS is on everywhere (should return **zero rows**):
   ```sql
   select tablename from pg_tables where schemaname='public' and rowsecurity=false;
   ```
6. From **Project Settings → API**, copy these three values for Step 3:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` public key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` secret key → `SUPABASE_SERVICE_ROLE_KEY` *(secret — never commit)*
7. **Auth settings** (so email signup works):
   - **Authentication → Providers → Email**: enable **Email**, and for staging
     turn **"Confirm email" ON** if you want to test the verification flow (you
     can toggle it OFF to sign in instantly while testing other flows).
   - **Authentication → URL Configuration → Site URL**: set to your staging URL
     (the Vercel URL from Step 2, or `http://localhost:3000` if running locally).
   - **Authentication → SMTP**: point Supabase's auth emails at your test inbox
     (Resend/Mailtrap SMTP creds), or use Supabase's built-in mailer for now.

---

## Step 2 — Host the app (Vercel) — or run locally

**Vercel (recommended):**
1. [vercel.com](https://vercel.com) → **Add New → Project** → import `vanta-labs`.
2. **Root Directory → `website`**. Framework auto-detects Next.js.
3. Add the environment variables from Step 3 **before** clicking Deploy.
4. Deploy. Note the `*.vercel.app` URL — that's your staging URL.

**Local instead:** create `website/.env.local` with the Step 3 variables and run
`npm install && npm run dev` → open `http://localhost:3000`.

---

## Step 3 — Environment variables (the important part)

Set these on Vercel (Project → Settings → Environment Variables) or in
`.env.local`. **The two lines in bold are what turn on the sandbox.**

| Name | Value |
|------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | *(from Step 1.6)* |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | *(from Step 1.6)* |
| `SUPABASE_SERVICE_ROLE_KEY` | *(from Step 1.6 — secret)* |
| `NEXT_PUBLIC_SITE_URL` | your staging URL (Vercel URL or `http://localhost:3000`) |
| **`PAYMENT_PROVIDER`** | **`mock`** ← sandbox card gateway |
| **`BILLING_PROVIDER`** | **`mock`** ← sandbox membership charges |
| `PAYMENT_WEBHOOK_SECRET` | any random string (or leave blank — mock uses a dev default) |
| `EMAIL_ENABLED` | `true` |
| `EMAIL_PROVIDER` | `resend` (or `smtp` for Mailtrap) |
| `EMAIL_FROM` | e.g. `Vanta Labs <test@yourdomain>` (Resend) |
| `RESEND_API_KEY` | *(if using Resend)* |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` | *(if using Mailtrap SMTP)* |
| `CRON_SECRET` | any long random string |

> **Safety:** `PAYMENT_PROVIDER` defaults to `live` if unset, and the sandbox
> `/pay/mock` page returns 404 unless `PAYMENT_PROVIDER=mock`. So you can never
> accidentally leave the fake gateway on in production — production simply
> doesn't set these to `mock`.

---

## Step 4 — Create your admin login

Run once against staging (needs the service-role key in your shell env):

```bash
cd website
node scripts/create-admin-credential.mjs   # follow the prompts
```

Then sign in at `/admin`. Set your 6-digit login code under
**Admin → My Account** (until you do, admin login is username + password only).

---

## Step 5 — Seed test data

A `staging-seed.sql` file is included: a few research products (with batch
numbers, purity %, COAs, and per-unit costs so the profit guard has real data),
one coupon, one approved ambassador with a referral code, and a low-stock item
to test inventory. Run it in the SQL Editor (Step 1.4). You can also add
everything through the **admin dashboard** instead — nothing here requires code.

---

## Step 6 — Test with fake money (the sandbox flow)

1. **Sign up** a customer at `/login` (use a real address on your test inbox).
   Confirm the verification email arrives in your test inbox.
2. Add products to cart → **Checkout**. Because `PAYMENT_PROVIDER=mock`, checkout
   sends you to a **sandbox pay page** (`/pay/mock/...`).
3. Test card **`4242 4242 4242 4242`** → **Pay now (approve)** → you land on the
   order confirmation page. Behind the scenes the *real* webhook pipeline runs:
   the order flips to **paid**, the confirmation email sends, **inventory
   decrements**, and any **ambassador commission / loyalty points** are recorded.
4. Test a **decline** with **Simulate decline** (or card `4000 0000 0000 0002`).
5. In **Admin → Orders**, **refund** the paid order → confirm commission
   reverses, points/store-credit return, and stock restocks.
6. Repeat per pricing case: **bundle (Buy 3 Get 1)**, **referral code**,
   **coupon**, **membership discount**, and combinations.
7. **Memberships:** with `BILLING_PROVIDER=mock`, subscribe and confirm the
   membership activates and perks apply; a decline test card exercises the
   past-due path.

Emails to look for in your test inbox: verification, order confirmation,
shipping update, delivery confirmation, membership activation, ambassador
approval, commission earned.

---

## When your REAL processor is approved (the swap)

No checkout rewrite — it's configuration:

1. Register a real `PaymentProvider` implementation for your processor in
   `src/lib/payment-provider.ts` (and a `BillingProvider` in
   `src/lib/billing-provider.ts` for recurring membership charges). These are
   the only code files that ever change, and only to add the new class.
2. Set on **production**: `PAYMENT_PROVIDER=<your-provider>` (not `mock`),
   `PAYMENT_SECRET_KEY`, `PAYMENT_PUBLIC_KEY`, `PAYMENT_WEBHOOK_SECRET`, and
   point the processor's webhook at `/api/webhooks/payment`.
3. The checkout, webhook handling, commissions, inventory, points, refunds, and
   emails are all already built and proven — they don't change.

Keep staging on `mock` forever; it's your safe place to test every future
change with fake money.
