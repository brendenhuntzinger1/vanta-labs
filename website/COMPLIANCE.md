# Compliance & Security Checklist — Vanta Labs

Status of security and compliance controls, plus the items that need a
**business, legal, or operational decision** from you before launch. This is
an engineering checklist, **not legal advice** — have counsel review anything
in the "Legal decisions" section.

---

## ✅ Implemented in code

### Security
- **Admin auth**: scrypt-hashed passwords, HTTP-only `sameSite=strict` session cookie, 12h expiry, login rate-limiting + lockout. Self-service password/username change (re-auth required) at **Admin → My Account**.
- **Authorization (RBAC)**: roles `staff` / `manager` / `super_admin`. Sensitive actions (refunds, payments verification, payouts, coupons, inventory, settings, bulk PII export) gated to manager+; team management to super_admin.
- **Every admin page and API route is authenticated** server-side; state-changing `/api/admin/*` also passes a same-origin (CSRF) check in middleware.
- **Webhook security**: both the payment webhook and the 3PL webhook require a valid **HMAC-SHA256 signature** (constant-time compare); unsigned/forged calls are rejected.
- **Payment integrity**: all prices/discounts/fees/tax are computed **server-side**; the client can't lower a total (guarded by an "altered total" tripwire).
- **Secrets**: API keys live in env or the admin settings store (never hardcoded); the Supabase service-role key is server-only; admin UIs mask stored secrets and only overwrite when a new value is entered.
- **File uploads** (payment proofs): type + magic-byte validation, size cap, stored in a **private** bucket, shown to admins via short-lived signed URLs.
- **RLS** enabled on orders, customer, membership, partner, and fulfillment tables; customer data is owner-scoped.
- **Input validation & sanitisation** on checkout, contact, search (`.or()` filters), and admin actions. Contact form has a honeypot + rate limit.
- **Audit logging**: admin actions (order updates, refunds, payment approve/reject, password/username changes, settings, policy edits) are written to `admin_audit_logs` (viewable in **Admin → Audit Log**).

### Compliance / ecommerce
- **Policies** (editable in **Admin → Policies**, no code): Terms, Privacy, Research Disclaimer, **Shipping**, **Return & Refund**, **Cookie**. Linked in the footer.
- **Cookie consent banner** with a link to the Cookie Policy.
- **Age gate** (21+) on first visit; checkout requires 3 explicit research/compliance/age acknowledgements.
- **Research-use-only** disclaimers throughout; "not for human/animal use" messaging.
- **Pricing transparency**: shipping, handling, tax, discounts, and the card processing fee are all shown at checkout **before** payment; the card fee has an explicit notice.
- **Membership terms**: non-refundable annual disclosed at signup and cancellation; recurring billing terms shown before purchase.
- **Business contact info** (`brendenhuntzinger1@vantalabsresearch.com`) on the site, in emails, and on policy pages; editable in Admin → Settings.
- **SEO/trust**: metadata, Open Graph, robots.txt, sitemap, favicon.

---

## ⬜ Needs YOUR decision before launch

### Legal decisions (get counsel to confirm)
- [ ] **Have a lawyer review** the Terms, Privacy, Refund, Shipping, Disclaimer, and Cookie policies (the built-in text is a solid template, not legal advice). Edit in Admin → Policies.
- [ ] **Card surcharge legality** — a 5% card fee is regulated/limited in some US states and often prohibited on debit cards. Confirm for the states you sell to, or disable/adjust it in Admin → Settings.
- [ ] **Research-chemical / peptide regulations** — confirm your products, labeling, and claims comply with FDA/FTC and state law for "research use only" materials, including any prohibited destinations.
- [ ] **Privacy law scope** — if you sell to CA (CCPA/CPRA), CO/VA/etc., or the EU/UK (GDPR), you may need specific disclosures, a "Do Not Sell/Share" link, and a data-request process. Decide your target markets.
- [ ] **Sales tax / nexus** — set the correct tax rate(s) in Admin (a single flat rate is supported today); confirm where you have nexus and whether per-state rates or a tax service are required.
- [ ] **Business entity, licensing, and 1099-K** reporting for your payment accounts — confirm with an accountant.
- [ ] **Chargeback/dispute policy** for manual payments (Cash App/Zelle have little buyer protection) — decide how you handle disputes.

### Operational decisions
- [ ] Use **business** (not personal) payment accounts; expect P2P freeze risk for this category.
- [ ] Decide who gets which **admin role**; create staff accounts in Admin → Team; rotate the initial password.
- [ ] Set your real **support email / hours**, shipping thresholds, tax rate, and membership perk values (so perks don't exceed membership revenue).
- [ ] Configure a real **email provider** (SMTP/Resend) so transactional emails actually send.
- [ ] Enter your **3PL** and (eventually) **card processor** credentials when available.

### Security follow-ups (recommended, not blocking)
- [ ] Restrict Supabase RLS policies are correct for any **new** tables you add later.
- [ ] Ensure your host (Vercel) passes a trustworthy client IP so login rate-limiting can't be spoofed via `X-Forwarded-For`.
- [ ] Consider adding **2FA** for admin logins.
- [ ] Set up **database backups** and a monitoring/alerting plan in Supabase.
- [ ] Rotate any secrets that were ever shared in plaintext.
- [ ] Add a rate limit to the public **payment-proof submit** endpoint if abuse appears.

---

## Notes
- Everything customer-facing (prices, policies, shipping, checkout steps) is designed to communicate clearly and avoid unsupported claims. Review product copy for any marketing language that implies human use or medical benefit and remove it.
- This checklist should be revisited whenever you add a payment provider, 3PL, or new product category.
