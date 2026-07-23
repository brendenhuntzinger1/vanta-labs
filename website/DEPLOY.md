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

## Updating later

Any change pushed to your production branch redeploys automatically. To change
a key or setting, edit it in **Vercel → Settings → Environment Variables**,
then **Deployments → ⋯ → Redeploy**.
