# Vanta Labs — 3PL Integration Requirements

Everything the fulfilment partner must provide or agree to. Written to be sent as-is.

Derived from the live integration code: `src/lib/fulfillment/provider.ts` (outbound),
`src/app/api/webhooks/fulfillment/route.ts` (inbound), `src/lib/fulfillment/service.ts` (status handling).

---

## 1. Credentials we need from you

| Item | Used for | Notes |
|---|---|---|
| **API base URL** | We POST orders to `{base}/orders` | HTTPS only |
| **API key / bearer token** | `Authorization: Bearer <key>` on every outbound call | |
| **Webhook signing secret** | You HMAC-sign callbacks to us; we reject unsigned ones | Shared secret, min 32 chars |
| **Sandbox/test environment** | End-to-end testing without shipping real product | Required before go-live |
| **SKU list / mapping confirmation** | Confirm our SKUs match yours — see §5 | |

We will give you: our webhook URL, and the SKU list.

---

## 2. Blind shipping — non-negotiable

**The customer must never learn another company is involved.** This is a hard requirement, not a preference.

- **Packing slips, invoices, labels and return address must show Vanta Labs only.** No partner logo, name, or address anywhere in or on the box.
- **No wholesale or partner pricing on any document in the parcel.** A previous test order reached a buyer showing the item as a **$0.00 FREE GIFT** at partner pricing. That cannot happen.
- **You must never email, SMS, or otherwise contact our customers.** Not order confirmations, not shipping notices, not marketing, not surveys.
- **Carrier account must not brand the shipment** with the partner name in tracking data.

### Why we send you a relay email address

We deliberately do **not** send you the buyer's real email. Every order carries a Vanta-controlled alias:

```
orders+VL-E8F4D52F@vantalabsresearch.com
```

It is a valid address, it is unique per order, and anything sent to it reaches **us**, not the buyer. If your API requires a customer email, this satisfies it. **Please confirm your system accepts it and will not reject the order.**

This exists because a partner's own notification system previously emailed our buyer its own branded confirmation, giving them two conflicting confirmations for one purchase from a company they had never heard of.

---

## 3. Outbound — the order we send you

`POST {apiBaseUrl}/orders` with `Authorization: Bearer <key>` and `Content-Type: application/json`.

```json
{
  "order_number": "VL-E8F4D52F",
  "reference": "order-b2ea193e-...",
  "customer": {
    "name": "Jane Doe",
    "email": "orders+VL-E8F4D52F@vantalabsresearch.com"
  },
  "shipping_address": {
    "address": "123 Research Way",
    "city": "Austin",
    "state": "TX",
    "postalCode": "78701",
    "country": "US"
  },
  "line_items": [
    { "sku": "glp-1", "variant": "5mg", "name": "GLP-1 (5mg)", "quantity": 1, "unit_price": 54.99 }
  ],
  "notes": "",
  "totals": { "subtotal": 54.99, "shipping": 15, "tax": 3.85, "total": 76.04 }
}
```

**Confirm for us:**
1. Do you accept this field naming, or do we need to remap? Tell us your exact required schema if so.
2. Which fields are **required** vs optional on your side?
3. Do you need a separate `address_line_2`? We currently send a single address line.
4. Is `unit_price` used for anything (customs, insurance), or ignored?
5. What is your rate limit, and your timeout?

**From your response we read** (any of these names): `id` / `order_id` / `reference` as your order ID, plus `tracking_number` / `tracking`, `carrier`, `tracking_url` if you have them at creation time.

---

## 4. Inbound — the webhooks you send us

`POST https://<our-domain>/api/webhooks/fulfillment`

**Signature (required).** Header `x-fulfillment-signature`, value `sha256=<hex>` where hex is `HMAC-SHA256(raw_request_body, shared_secret)`. The `sha256=` prefix is optional. **We reject anything that fails this check with 401.** Sign the raw body bytes exactly as sent.

### 4a. Status updates

```json
{
  "type": "status",
  "reference": "order-b2ea193e-...",
  "status": "shipped",
  "tracking_number": "1Z0037BB0313242143",
  "carrier": "UPS",
  "shipping_cost": 8.42
}
```

**`status` must be one of exactly these values** — anything else is ignored and the customer's order never updates:

| Value | Meaning |
|---|---|
| `processing` | Picked / in progress |
| `shipped` | Handed to carrier — **triggers the customer's shipping email** |
| `delivered` | Delivered — triggers the delivery email |
| `cancelled` (or `canceled`) | Cancelled |

Identify the order by `reference` (preferred), `order_id`, or `order_number`.

**Send each status transition once.** We de-duplicate, but repeated transitions risk noise.

### 4b. Tracking requirements — important

- **`carrier` must be the real carrier's name**: `UPS`, `USPS`, `FedEx`, `DHL`, or `OnTrac`. Not your company name, not a service brand.
- We **build the tracking link ourselves** from carrier + tracking number and point it at the carrier's own site. We ignore any `tracking_url` you send. Send the number and carrier; the URL is optional and unused.
- If the carrier is not one we recognise, **the customer sees no tracking link at all** — so the carrier name matters.
- **We ship UPS.** Confirm that is what you'll use, and tell us if any order would ship by another carrier.

### 4c. Shipping cost (needed for our margins)

Include the actual label cost in dollars on the shipped event, under any of: `shipping_cost`, `label_cost`, `shipping_label_cost`, `postage_cost`, `actual_shipping_cost`. This replaces our estimate and finalises the order's profit automatically. **Without it our margin reporting stays an estimate forever.**

### 4d. Inventory sync

```json
{
  "type": "inventory",
  "inventory": [
    { "sku": "glp-1", "variant": "5mg", "quantity": 42 },
    { "sku": "bpc-157", "variant": "10mg", "quantity": 0 }
  ]
}
```

- **You are the source of truth for stock.** Quantity `0` marks the item Out of Stock on our storefront and blocks purchase; any positive number puts it back on sale.
- **`variant` is required when a product has multiple doses.** Without it, every dose of a product shares one number, and a sold-out dose still shows as sellable — we will oversell it.
- **How often can you push this?** Real-time on change is best; hourly is acceptable. Tell us which.
- Can you also expose a pull endpoint we can poll as a fallback?

### 4e. Errors

```json
{ "type": "error", "reference": "order-...", "message": "Human-readable reason" }
```

Send this when an order cannot be fulfilled. It raises an internal alert. **The message goes only to us, never to the customer** — but write it as plain operational text regardless.

---

## 5. SKUs and variants

Our `sku` is the product slug (e.g. `glp-1`) and `variant` is the dose (e.g. `5mg`). Inventory callbacks must match on the **same** pair.

**Confirm:** do you use our SKU values directly, or do you have your own codes we must map? If the latter, send the mapping table and we'll store it on our side.

---

## 6. Operational questions

1. **Cut-off time** for same-day dispatch, and days you ship.
2. **Turnaround** from order receipt to carrier handoff.
3. **How do you handle a partial fulfilment** (one line in stock, one not)? We currently expect whole-order statuses.
4. **Returns / RTS** — what happens to a refused or undeliverable parcel, and how do you notify us?
5. **Damaged or lost in transit** — claim process and who files it.
6. **Payout model** — per unit or percentage, and the rate. We track what's owed per order.
7. **Sandbox credentials** and how to trigger each webhook type there.
8. **Escalation contact** for a stuck order.

---

## 7. Go-live checklist

- [ ] Sandbox credentials received and connectivity test passes (admin → Fulfilment → Test Connection)
- [ ] Blind-shipping confirmed **in writing**, and verified on a physical test parcel
- [ ] Test parcel inspected: no partner branding, no wholesale pricing, Vanta Labs return address
- [ ] Relay email address accepted by your API without rejection
- [ ] Signed webhook verified end to end (a deliberately bad signature must be rejected)
- [ ] Each status value delivered and confirmed to move the order on our side
- [ ] `carrier` arrives as `UPS` and the customer's tracking link opens UPS
- [ ] Shipping cost arrives on the shipped event and finalises profit
- [ ] Inventory sync arrives with `variant` and correctly flips an item out of stock and back
- [ ] Error webhook raises an alert
- [ ] SKU mapping confirmed for every live product
