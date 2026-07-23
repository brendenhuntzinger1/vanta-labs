# What to do next

Two parts:

- **Part 1 — Go live with what's already done.** Plain-English, ~10 minutes. Do
  this now.
- **Part 2 — The deferred fixes.** Copy-paste-ready code for your developer, in
  priority order. Each one touches money/orders, so apply it, run it on a
  **staging/preview** database first, confirm, then promote to production.

---

# Part 1 — Ship what's merged (do this now)

Everything below is already on branch `claude/ecommerce-platform-audit-h4oxln`
and passes type-check, lint, 60 tests, and a production build.

### 1. Run the database migration

Supabase Dashboard → **SQL Editor** → **New query** → paste the **entire**
contents of `website/src/lib/sql/deploy-run-once.sql` → **Run**. Expect
"Success. No rows returned." (It's safe to re-run; it now also adds the admin
passcode columns and turns on Row Level Security everywhere.)

Then confirm RLS is on everywhere — this must return **zero rows**:

```sql
select tablename from pg_tables where schemaname = 'public' and rowsecurity = false;
```

### 2. Turn on the admin passcode

Pick **one**:

- **Global (simplest):** Vercel → your project → **Settings → Environment
  Variables** → add `ADMIN_ACCESS_CODE` = a 6-digit number of your choice →
  **Save** → redeploy. Every admin now uses this code.
- **Per-admin (better):** log into the admin, go to **Team**, click **Set
  passcode** next to each person. A per-admin passcode overrides the global one.

> If you set neither, login still works with just username + password (so you're
> never locked out) — but set one to actually enable the second step.

### 3. Deploy & smoke-test

Merge the branch (or open a PR and merge). Vercel redeploys automatically. Then:

- [ ] Go to `/vault` — you should see **three** fields: username, password,
      6-digit passcode. Log in.
- [ ] Try a wrong passcode — it should reject with a generic error.
- [ ] Open the storefront, a product page, add to cart, reach checkout — confirm
      nothing broke (RLS shouldn't affect it; all data goes through the server).
- [ ] In the admin: open Orders, Partners, Products — confirm they still load.

If any admin page shows no data after step 1, it means a table you rely on for a
direct browser read wasn't expected — tell me and I'll adjust that table's policy.
(Based on the audit, nothing should; every read goes through the server.)

---

# Part 2 — Deferred fixes (priority order)

These were **not** shipped on purpose: they change the live payment/order path
and must be verified against a staging database first. Apply them one at a time.

## 1. Stop overselling inventory  *(highest priority)*

Today stock is **never decremented when an order is paid** — the checkout only
*reads* the count, so two shoppers can both buy the last unit. Fix: an atomic
decrement that fails when stock is insufficient.

**Migration** (Supabase SQL editor):

```sql
create or replace function public.decrement_product_inventory(p_product_id uuid, p_qty int)
returns boolean
language plpgsql
security definer
as $$
declare updated int;
begin
  update public.products
     set inventory_quantity = inventory_quantity - p_qty
   where id = p_product_id
     and inventory_quantity is not null
     and inventory_quantity >= p_qty;
  get diagnostics updated = row_count;
  return updated > 0;  -- false = not enough stock (or stock isn't tracked)
end $$;

-- variant-level equivalent, for products sold by dose/vial size:
create or replace function public.decrement_dose_inventory(p_dose_id uuid, p_qty int)
returns boolean
language plpgsql
security definer
as $$
declare updated int;
begin
  update public.product_doses
     set inventory_quantity = inventory_quantity - p_qty
   where id = p_dose_id
     and inventory_quantity is not null
     and inventory_quantity >= p_qty;
  get diagnostics updated = row_count;
  return updated > 0;
end $$;
```

**Where to call it:** at the moment an order becomes **paid**, not at order
creation — i.e. inside `finalizeManualPayment` (manual Cash App/Zelle/PayPal
approval) and the card `paid` block, both in `src/lib/payment-webhook.ts`. For
each paid order, load its `order_items` and call the RPC per line:

```ts
const { data: rpcOk } = await supabaseAdmin.rpc("decrement_product_inventory", {
  p_product_id: item.product_id,
  p_qty: item.quantity,
});
if (rpcOk === false) {
  // Not enough stock. Don't silently oversell: flag the order for review.
  await supabaseAdmin.from("orders")
    .update({ fulfillment_status: "needs_review" })
    .eq("order_id", orderId);
}
```

Note: `products.inventory_quantity` (and `product_doses.inventory_quantity`) is
also overwritten by the 3PL sync when connected. If the 3PL is your source of
truth, keep decrementing locally between syncs so you don't oversell in the gap.

## 2. Make the payment webhook idempotent per order

The manual-payment path (`finalizeManualPayment`) already claims the order
atomically before running side-effects. The **card** `paid` path does not, so two
deliveries with different `event_id`s for the same order can both award
commission/points and both email. Mirror the manual path — gate the paid block on
a conditional claim (in `src/lib/payment-webhook.ts`):

```ts
const { data: claimed } = await supabaseAdmin
  .from("orders")
  .update({ payment_status: "paid", paid_at: new Date().toISOString() })
  .eq("order_id", orderId)
  .neq("payment_status", "paid")
  .select("order_id")
  .maybeSingle();

if (!claimed) {
  // Another delivery already finalized this order — do NOT re-run side-effects.
  await markEventProcessed(eventId, orderId, "paid");
  return { duplicate: false, eventId, orderId, status: "paid", providerStatus: "paid" };
}
// ...only now run commission / points / coupon / email / 3PL...
```

## 3. Prevent duplicate orders on refresh / double-submit

Right now the only guard against a second order is a client-side button flag; a
refresh, retry, or back-button re-submit creates a duplicate order.

**Migration:**

```sql
alter table public.orders add column if not exists idempotency_key text;
create unique index if not exists idx_orders_idempotency_key
  on public.orders(idempotency_key) where idempotency_key is not null;
```

**Client** (`src/app/checkout/page.tsx`): generate one key per checkout attempt
and send it with the create-session request:

```ts
const idempotencyKey = crypto.randomUUID(); // once, when the checkout page mounts
// include it in the POST body to /api/checkout/create-session
```

**Server** (`src/lib/payment-service.ts`, before inserting the order): if an
order with that key already exists, return it instead of creating a new one.
While you're there, insert `orders` and `order_items` inside a single Postgres
function (transaction) so a half-failed insert can't leave an order with no line
items.

## 4. Stop the webhook zeroing out order totals

`upsertOrderRecord` overwrites `subtotal/discount/shipping/amount_paid` from the
webhook payload's top-level fields, but the real numbers were written to the
processor **metadata**. For an order that already exists, read those columns from
the stored order (like `finalizeManualPayment` does) instead of the payload, and
compute commission from the stored order. Otherwise a minimal event can set the
order — and the ambassador's commission — to $0.

## 5. Verify account-verification & password-reset emails actually send

These currently use Supabase's **built-in** auth mailer, not your in-app email
provider — the branded templates in `src/lib/email/templates.ts` are never used.
If you've only configured the in-app provider (Resend/SMTP), signup verification
and password reset can silently fail. Do one of:

- **Supabase Dashboard → Authentication → Emails** → set custom SMTP + paste the
  branded templates; **or**
- add explicit `/api/auth/verify` and `/api/auth/reset` routes that call
  `sendEmail()` with the existing `emailVerificationTemplate` /
  `passwordResetTemplate`.

Test end-to-end: sign up with a real address, confirm the email arrives; request
a password reset, confirm it arrives.

## 6. Add real rate limiting to public endpoints

`coupons/validate`, `catalog/welcome-offer`, `catalog/back-in-stock`, and
`partner/apply` have none (enables coupon-code guessing and email spam), and
`contact`/`account/reorder` use an in-memory limiter that resets on every
serverless cold start. Back all of them with a shared store — the simplest for
this stack is a Supabase table keyed on `(ip, endpoint, window)` checked before
the work runs.

---

## Full findings & lower-priority items

Everything found in the audit — including membership proration, the coupon
over-redemption race, store-credit reconciliation, cookie-consent enforcement,
and the support-email-from-settings cleanup — is catalogued with severity in
**`website/AUDIT_REPORT.md`**.

Want me to implement any of Part 2? Say which number(s) and I'll write it,
add tests, and open a PR — but I'll need you (or a staging database) to verify
the order/payment behavior before it goes to production.
