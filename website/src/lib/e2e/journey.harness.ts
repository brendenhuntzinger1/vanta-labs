/**
 * The world one certification journey runs inside.
 *
 * Everything here is either a real application module or a boundary that would
 * spend money / need physical infrastructure. Nothing in between is faked:
 * pricing, order writing, idempotency, the fulfillment state machine, the
 * emails' own send-or-not decision and the profit math are all the shipping
 * code, reading and writing one shared in-memory database.
 *
 * THE BOUNDARIES, and why each one is drawn where it is:
 *
 *   • Shippo HTTP client — a real call creates an order in a live account and
 *     `purchase` spends postage. Mocked at `@/lib/shippo/client`, the lowest
 *     layer that talks to the network, so order-sync.ts, service.ts and the
 *     webhook routes above it are all genuine.
 *   • Email transport — mocked at `@/lib/email/send` so a message is COUNTED
 *     rather than delivered. Every decision about whether to send, to whom, and
 *     which template, is made by the real code above it.
 *   • Payment processor — the repository's own MockPaymentProvider, which signs
 *     with the same HMAC the live provider verifies. The webhook route verifies
 *     that signature for real.
 *
 * What this can therefore never prove: a real card settlement, a real label
 * purchase, a real carrier scan, and real inbox delivery. Those stay on the
 * live-certification list.
 */

import { createFakeDb, type FakeDb, type Row } from "@/lib/e2e/fake-db";

export const WEBHOOK_SECRET = "e2e-test-payment-webhook-secret";
export const SHIPPO_WEBHOOK_SECRET = "e2e-test-shippo-webhook-secret";

export interface SentEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface ShippoCall {
  kind: "order" | "shipment";
  payload: unknown;
}

export interface Harness {
  db: FakeDb;
  emails: SentEmail[];
  shippoCalls: ShippoCall[];
  /** Fail the next N Shippo order creations, to test the sweep's recovery. */
  shippoOrderFailures: number;
  /** Fail the next N email sends, as a provider outage does. */
  emailFailures: number;
  nextShippoOrderId: string;
  nextShipmentId: string;
  reset(): void;
}

export const harness: Harness = {
  db: createFakeDb(),
  emails: [],
  shippoCalls: [],
  shippoOrderFailures: 0,
  emailFailures: 0,
  nextShippoOrderId: "shippo_order_default",
  nextShipmentId: "shippo_shipment_default",
  reset() {
    this.db = createFakeDb();
    this.emails = [];
    this.shippoCalls = [];
    this.shippoOrderFailures = 0;
    this.emailFailures = 0;
  },
};

/** Emails sent to one address, by template subject. */
export function emailsTo(address: string): SentEmail[] {
  return harness.emails.filter((email) => email.to.toLowerCase() === address.toLowerCase());
}

/**
 * How many emails of a kind reached one customer.
 *
 * Matches on the SUBJECT the real template produced, so a change that starts
 * sending the wrong template to the right person is still visible.
 */
export function countEmails(address: string, matcher: RegExp): number {
  return emailsTo(address).filter((email) => matcher.test(email.subject)).length;
}

// ---------------------------------------------------------------- seeding --

export interface SeedProduct {
  slug: string;
  name: string;
  priceCents: number;
  inventory: number;
  unitCostCents: number;
  weightOz: number;
}

/**
 * A store with real stock, real prices and the two addresses shipping requires.
 *
 * SENTINEL ADDRESSES ONLY. The ship-from origin here is a synthetic placeholder
 * — never the owner's real private address, which must not appear in a test, a
 * fixture, a log or a commit.
 */
export function seedStore(db: FakeDb, products: SeedProduct[]): void {
  db.seed(
    "products",
    products.map((product, index) => ({
      id: `product-${index + 1}`,
      slug: product.slug,
      name: product.name,
      category: "Research Peptides",
      description: "Synthetic research peptide.",
      short_description: "Research use only.",
      price_cents: product.priceCents,
      stock_status: "In Stock",
      inventory_quantity: product.inventory,
      reserved_quantity: 0,
      track_inventory: true,
      product_cost_cents: product.unitCostCents,
      shipping_weight_oz: product.weightOz,
      is_active: true,
      is_enabled: true,
      is_published: true,
      is_archived: false,
      is_featured: false,
      position: index,
      batch_number: "VL-TEST01",
      purity_result: "99.5%",
      image_url: "/images/vantalabs.png",
      testing_date: "2026-07-10",
      lab_name: "Vanta Independent Testing Group",
      coa_url: "/demo-coa.pdf",
    })),
  );

  db.seed("shipping_package_presets", [
    {
      id: "preset-default",
      name: "Small mailer",
      length_in: 9,
      width_in: 6,
      height_in: 2,
      empty_weight_oz: 1.2,
      is_default: true,
      is_active: true,
    },
  ]);

  // Control-centre settings live as audit-log rows; this is the real storage
  // shape getControlSnapshot reads.
  const control = (section: string, key: string, value: unknown, index: number): Row => ({
    id: `control-${section}-${key}-${index}`,
    action: "admin_control_upsert",
    target_table: section,
    target_id: key,
    metadata: { value },
    created_at: new Date(Date.now() - index * 1000).toISOString(),
  });

  const settings: Array<[string, string, unknown]> = [
    ["shipping_origin", "name", "Vanta Fulfillment"],
    ["shipping_origin", "street1", "1 Synthetic Origin Way"],
    ["shipping_origin", "city", "Testville"],
    ["shipping_origin", "state", "FL"],
    ["shipping_origin", "zip", "33500"],
    ["shipping_origin", "country", "US"],
    ["shipping_origin", "phone", "555-0100"],
    ["shipping_return_address", "name", "Vanta Labs Returns"],
    ["shipping_return_address", "street1", "2 Synthetic Return Road"],
    ["shipping_return_address", "city", "Returnville"],
    ["shipping_return_address", "state", "FL"],
    ["shipping_return_address", "zip", "33501"],
    ["shipping_return_address", "country", "US"],
    ["shipping_return_address", "phone", "555-0101"],
  ];

  db.seed("admin_audit_logs", settings.map(([section, key, value], index) => control(section, key, value, index)));
}

// ------------------------------------------------------------- checkout in --

export interface Shopper {
  email: string;
  fullName: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
}

export function checkoutBody(shopper: Shopper, items: Array<{ productId: string; quantity: number }>) {
  return {
    // The cart line's `id` is the slug (plus an optional "::dose" suffix) —
    // the same shape the storefront's cart context posts.
    items: items.map((item) => ({ id: item.productId, quantity: item.quantity })),
    customer: { ...shopper },
    paymentMethod: "card",
    // The TWO acknowledgements a purchase requires. Both lanes share one
    // validator, so a statement cannot be required in one and forgotten in the
    // other. They render pre-ticked; this fixture matches what an untouched
    // checkout actually submits.
    complianceAcknowledgements: {
      researchCompliance: true,
      returnsPolicy: true,
    },
  };
}
