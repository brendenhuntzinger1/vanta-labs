# Vanta Labs

E-commerce storefront for a research-peptide company — built with Next.js,
Supabase, and Tailwind CSS.

The application lives in [`website/`](./website).

## What's inside

- **Storefront** — catalog, product pages, COA library, cart, and a premium
  checkout with manual payment methods (Cash App / Zelle / PayPal) plus an
  optional card option with a configurable processing fee.
- **Admin dashboard** — products, pricing, inventory, promotions, payment
  verification, fulfillment queue, revenue/payout dashboards, memberships,
  referral codes, policies, and site content — all editable without code.
- **Memberships & rewards** — annual (one-time manual payment) and monthly
  (recurring card) tiers, loyalty points, referral/ambassador program.
- **Fulfillment** — provider-agnostic 3PL integration that activates once
  API credentials are entered.
- **Growth** — welcome offer, back-in-stock notifications, subscribe-and-save,
  and an SEO research library.

## Getting started

```bash
cd website
npm install
npm run dev
```

Copy `website/.env.example` to `website/.env.local` and fill in your Supabase
values to run locally.

## Deploying

See [`website/DEPLOY.md`](./website/DEPLOY.md) for step-by-step Vercel setup.

## Documentation

- [`website/DEPLOY.md`](./website/DEPLOY.md) — deployment guide
- [`website/DATABASE.md`](./website/DATABASE.md) — database schema reference
- [`website/COMPLIANCE.md`](./website/COMPLIANCE.md) — compliance checklist
- Database migrations live in `website/src/lib/sql/`
