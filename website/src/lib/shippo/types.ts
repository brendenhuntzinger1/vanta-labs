// -------------------------------------------------------------------------
// Wire types for the Shippo REST API (https://api.goshippo.com).
//
// These mirror Shippo's JSON EXACTLY — snake_case keys, money as a decimal
// string — rather than a prettier internal shape. Renaming fields on the way in
// is where drift starts: a typo in a mapper turns into a silently-undefined
// `label_url` and an order that looks shipped with no label. Anything that
// wants a friendlier shape converts at the edge (client.ts returns purpose-built
// results; parcel.ts builds the wire parcel).
//
// Only the fields Vanta Labs actually reads are declared. Shippo returns many
// more; leaving them out is deliberate — inventing a type for a field nobody has
// verified would look authoritative and be wrong.
// -------------------------------------------------------------------------

/**
 * An address as Shippo wants it.
 *
 * `state` is not optional: Shippo rejects a US shipment without a state, and the
 * failure arrives as a generic 400 during rate creation, long after the admin
 * typed the address. Requiring it here makes the omission a compile error.
 * `country` is ISO 3166-1 alpha-2 ("US"), never a display name.
 */
export interface ShippoAddress {
  name: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
  email?: string;
}

/**
 * A parcel. Dimensions and weight are strings because that is what Shippo's API
 * documents and returns, and a string round-trips a decimal without a float
 * ever touching it.
 *
 * The units are narrowed to inches/ounces on purpose: every Vanta Labs preset is
 * stored in in/oz, and a mismatched unit (cm dimensions labelled "in") is a
 * mispriced label that still buys successfully — the worst kind of bug because
 * nothing errors.
 */
export interface ShippoParcel {
  length: string;
  width: string;
  height: string;
  distance_unit: "in";
  weight: string;
  mass_unit: "oz";
}

export interface ShippoServiceLevel {
  name: string;
  token: string;
  terms?: string | null;
}

/**
 * A quoted rate.
 *
 * `amount` is a DECIMAL STRING ("5.20"), never a number. Do not parse it with
 * `Number(amount) * 100` — 1.15 * 100 is 114.99999999999999, which truncates to
 * an under-recorded postage cost. Use `parseAmountToCents()` from client.ts.
 */
export interface ShippoRate {
  object_id: string;
  amount: string;
  currency: string;
  /** "USPS" | "UPS" | "FedEx" — free text from Shippo, so typed as string. */
  provider: string;
  provider_image_75?: string | null;
  provider_image_200?: string | null;
  servicelevel: ShippoServiceLevel;
  estimated_days?: number | null;
  duration_terms?: string | null;
  attributes?: string[];
}

/** Shippo's per-object diagnostics: why an address failed, why a purchase erred. */
export interface ShippoMessage {
  source?: string | null;
  code?: string | null;
  text?: string | null;
}

export interface ShippoShipment {
  object_id: string;
  status?: string;
  address_from?: ShippoAddress;
  address_to?: ShippoAddress;
  parcels?: ShippoParcel[];
  /** Empty when Shippo could quote nothing — almost always a bad address. */
  rates: ShippoRate[];
  messages?: ShippoMessage[];
  object_created?: string;
}

/** Label formats Shippo can print. Vanta Labs buys PDF_4x6 (thermal-printer size). */
export type ShippoLabelFileType = "PDF_4x6" | "PDF" | "PDF_A4" | "PNG" | "ZPLII";

/**
 * Transaction lifecycle.
 *
 * SUCCESS and ERROR are terminal. QUEUED/WAITING should not appear when the
 * request sets `async: false`, but they are declared because treating an
 * unexpected pending transaction as "failed" is exactly how a second label gets
 * bought for the same order.
 */
export type ShippoTransactionStatus =
  | "SUCCESS"
  | "ERROR"
  | "QUEUED"
  | "WAITING"
  | "REFUNDED"
  | "REFUNDPENDING"
  | "REFUNDREJECTED";

export interface ShippoTransaction {
  object_id: string;
  status: ShippoTransactionStatus;
  tracking_number?: string | null;
  /** Present on some responses as the coarse tracking state of the label. */
  tracking_status?: ShippoTrackingStatus | null;
  label_url?: string | null;
  /** The CARRIER's tracking page. Never shown to a customer verbatim — see tracking-url.ts. */
  tracking_url_provider?: string | null;
  /**
   * The rate's object_id, or the expanded rate object depending on which
   * endpoint answered. Both shapes are real, so both are typed.
   */
  rate?: string | ShippoRate | null;
  commercial_invoice_url?: string | null;
  messages?: ShippoMessage[];
  object_created?: string;
}

/** A refund (void) is accepted asynchronously by most carriers — QUEUED is normal. */
export type ShippoRefundStatus = "QUEUED" | "PENDING" | "SUCCESS" | "ERROR";

export interface ShippoRefund {
  object_id: string;
  status: ShippoRefundStatus;
  /** The voided transaction's object_id. */
  transaction: string;
  messages?: ShippoMessage[];
  object_created?: string;
}

/** Every tracking state Shippo emits. Mapped to a Vanta status in order-pipeline.ts. */
export type ShippoTrackingStatus =
  | "UNKNOWN"
  | "PRE_TRANSIT"
  | "TRANSIT"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "RETURNED"
  | "FAILURE";

export const SHIPPO_TRACKING_STATUSES: readonly ShippoTrackingStatus[] = [
  "UNKNOWN",
  "PRE_TRANSIT",
  "TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURNED",
  "FAILURE",
];

/**
 * Narrows an untrusted webhook string to a known status.
 *
 * A webhook body is attacker-shaped input until proven otherwise: an unknown
 * status must fall out here and be ignored, never be forwarded into the status
 * pipeline where it could write nonsense into `fulfillment_status`.
 */
export function isShippoTrackingStatus(value: unknown): value is ShippoTrackingStatus {
  return typeof value === "string" && (SHIPPO_TRACKING_STATUSES as readonly string[]).includes(value);
}

export interface ShippoTrackingStatusDetail {
  status: ShippoTrackingStatus;
  status_details?: string | null;
  status_date?: string | null;
}

/** The only webhook event Vanta Labs subscribes to. */
export const SHIPPO_TRACK_UPDATED_EVENT = "track_updated";

export interface ShippoTrackingUpdate {
  tracking_number?: string | null;
  carrier?: string | null;
  tracking_status?: ShippoTrackingStatusDetail | null;
  /** The transaction object_id this parcel's label came from, when Shippo knows it. */
  transaction?: string | null;
  eta?: string | null;
}

/**
 * A webhook delivery.
 *
 * `event` is a plain string rather than a literal type: Shippo can enable other
 * event types on the account at any time, and a body that fails to type-check
 * would be thrown away by the route instead of being answered with a polite 200.
 */
export interface ShippoWebhookPayload {
  event: string;
  data: ShippoTrackingUpdate;
}

// ------------------------------------------------------------------ orders ----

/**
 * A line on a Shippo ORDER — what appears in the Orders tab of Shippo's
 * dashboard when the owner opens an order to buy its label.
 *
 * Distinct from a parcel: the parcel is one box with one total weight, while
 * these are the individual products, shown so the packer can verify what goes
 * in the box before buying postage.
 */
export interface ShippoOrderLineItem {
  title: string;
  sku?: string;
  quantity: number;
  total_price: string;
  currency: string;
  weight: string;
  weight_unit: "oz" | "lb" | "g" | "kg";
}

export interface ShippoOrderInput {
  to_address: ShippoAddress;
  from_address: ShippoAddress;
  line_items: ShippoOrderLineItem[];
  placed_at: string;
  /**
   * The Vanta Labs order number, verbatim.
   *
   * This is the human-readable join between the two systems: it is what the
   * owner reads in Shippo's Orders list and matches against the admin. It is
   * NOT the machine matching key — see ShippoOrder.object_id for that.
   */
  order_number: string;
  order_status: "PAID" | "AWAITPAY" | "SHIPPED" | "CANCELLED" | "REFUNDED";
  shipping_cost: string;
  shipping_cost_currency: string;
  shipping_method?: string;
  subtotal_price: string;
  total_price: string;
  total_tax: string;
  currency: string;
  /** The computed parcel weight, so Shippo pre-fills it rather than asking. */
  weight: string;
  weight_unit: "oz" | "lb" | "g" | "kg";
  notes?: string;
}

export interface ShippoOrder {
  /**
   * Shippo's id for the order. Persisted on our order row as the AUTHORITATIVE
   * matching key when a label is later bought in Shippo's dashboard — matching
   * on customer name or email would collide the moment one customer places two
   * orders, and would silently attach a label cost to the wrong one.
   */
  object_id: string;
  order_number?: string | null;
  order_status?: string | null;
}

/**
 * The `transaction_created` webhook body, fired when a label is purchased —
 * including a purchase made by hand in Shippo's own dashboard, which is the
 * whole point of this integration.
 */
export interface ShippoTransactionCreated {
  object_id?: string | null;
  /**
   * When Shippo created this transaction. Read so a late or reordered delivery
   * can be compared against the label already on the order — see
   * applyTransactionCreated. Optional because a thin delivery may omit it.
   */
  object_created?: string | null;
  status?: string | null;
  tracking_number?: string | null;
  tracking_url_provider?: string | null;
  label_url?: string | null;
  /** Present when the label was bought against a Shippo Order. */
  order?: string | null;
  /**
   * EITHER the expanded rate OR just its object_id — exactly like
   * ShippoTransaction.rate above, and for the same reason: which one arrives
   * depends on how the label was bought.
   *
   * This was typed as the object alone, so `data.rate?.amount` compiled
   * cleanly and silently produced undefined whenever Shippo sent the string
   * form. A label bought from Shippo's own dashboard came through with no
   * cost, no carrier and no service, the order still moved to
   * `label_purchased`, and the profit line stayed "ESTIMATED" for ever. Three
   * real orders reached that state before anyone noticed.
   *
   * Typing the truth is what makes the narrow read a compile error rather than
   * a silent null.
   */
  rate?:
    | string
    | {
        object_id?: string | null;
        amount?: string | null;
        currency?: string | null;
        provider?: string | null;
        servicelevel?: { name?: string | null; token?: string | null } | null;
      }
    | null;
  metadata?: string | null;
}
