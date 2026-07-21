# Deploying Vanta Labs to Vercel

Plain-English steps to put the site live. Do these in order. You only do
steps 1–4 once; after that, every `git push` redeploys automatically.

---

## 1. Run the database migrations (Supabase)

Supabase Dashboard → **SQL Editor** → **New query** → paste the contents of
each file below → **Run**. They're safe to re-run.

- `src/lib/sql/manual-payments.sql`
- `src/lib/sql/fulfillment-3pl.sql`
- `src/lib/sql/membership-orders.sql`
- `src/lib/sql/growth-features.sql`

(These build on the base schema in `orders-schema.sql`, which is already live.)

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

## Updating later

Any change pushed to your production branch redeploys automatically. To change
a key or setting, edit it in **Vercel → Settings → Environment Variables**,
then **Deployments → ⋯ → Redeploy**.
