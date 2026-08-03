/**
 * The order reference a CUSTOMER sees.
 *
 * Orders carry two identifiers: `order_number` (VL-E8F4D52F — short, quotable,
 * designed to be read aloud to support) and `order_id` (order-8f2f12b9-62b5-
 * 4630-9ff5-b11f27702553 — a database key). Customer surfaces were written as
 * `orderNumber ?? orderId`, so whenever the number is missing the shopper is
 * shown a 45-character database key instead — on the confirmation page, the
 * order list, the order detail page, and the downloadable invoice they keep.
 *
 * That fallback is not theoretical: order VL-49CA32C1 reached "paid" with a
 * null customer_email and null customer_name, so fields that "cannot" be null
 * demonstrably are.
 *
 * A missing number now renders in the same VL-XXXXXXXX shape as a real one,
 * derived deterministically from the id's leading hex. Support can still find
 * the row — `where order_id like 'order-8f2f12b9%'` — without the shopper ever
 * seeing a raw key.
 */

/** Formats the reference to show a customer. Never returns a raw database id. */
export function displayOrderReference(
  orderNumber: string | null | undefined,
  orderId: string | null | undefined,
): string {
  const number = (orderNumber ?? "").trim();
  if (number) return number;

  // Strip the "order-" prefix and dashes, then take the leading hex. A v4 UUID's
  // first block is 8 hex characters — enough to identify a row in practice and
  // to prefix-search on.
  const raw = (orderId ?? "").trim().replace(/^order-/i, "").replace(/-/g, "");
  const token = raw.slice(0, 8).toUpperCase();

  // Nothing usable at all — show a neutral placeholder rather than an empty
  // heading or a stray "order-".
  if (!token) return "Pending";

  return `VL-${token}`;
}
