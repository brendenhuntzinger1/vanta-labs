import type { ShippoServiceErrorCode } from "@/lib/shippo/service";

// ---------------------------------------------------------------------------
// Service error code -> HTTP status.
//
// Not a route file (only `route.ts` is routable), just the one table the three
// shipping handlers in this folder share. It lives here rather than in the
// service because HTTP is the route layer's concern: the service says WHAT went
// wrong, this says how an HTTP client should read it.
//
// The distinctions that matter to the admin UI:
//   * 409 means "nothing was bought, and re-sending this exact request will not
//     help" — re-quote, or wait for the in-flight purchase.
//   * 502 means Shippo misbehaved; a retry is reasonable.
//   * 400 means the store's own data is wrong (address, origin, parcel) and a
//     retry is pointless until a human fixes it.
// ---------------------------------------------------------------------------

const STATUS_BY_CODE: Record<ShippoServiceErrorCode, number> = {
  // Refused by policy, not by input. Vanta does not buy postage; a retry of the
  // same request will never succeed while that is true, so it must not look
  // retryable the way a 409 or 502 does.
  purchasing_disabled: 403,
  order_not_found: 404,
  not_shippable: 400,
  origin_incomplete: 400,
  destination_incomplete: 400,
  // The token is missing from the server environment — an operator problem, not
  // a client one.
  not_configured: 503,
  no_rates: 400,
  shippo_error: 502,
  rate_expired: 409,
  purchase_in_progress: 409,
  no_label: 404,
  label_voided: 409,
  // A label exists but its cost could not be recorded. The request did NOT fully
  // succeed, and it must not be retried — 502 keeps it out of the 4xx bucket a
  // client would treat as "fix your input and resend".
  cost_unrecorded: 502,
  db_error: 500,
  invalid_request: 400,
};

export function httpStatusForShippoError(code: ShippoServiceErrorCode): number {
  return Object.prototype.hasOwnProperty.call(STATUS_BY_CODE, code) ? STATUS_BY_CODE[code] : 400;
}
