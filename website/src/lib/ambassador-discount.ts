/**
 * The discount an ambassador's code gives the customer.
 *
 * Per-ambassador override first, program default when unset. Pure, dependency
 * free, and in its own module on purpose: the payment webhook needs this rule,
 * and importing it from quote-order.ts dragged the catalog, tax, shipping,
 * coupon and membership modules into the webhook's import graph for the sake of
 * six lines. The most critical file in the system should not carry that.
 *
 * NULL inherits, it does not mean zero. An owner clearing the field means "use
 * the program default"; reading it as 0% would silently strip the discount from
 * that ambassador's customers while the code kept working, so nobody would
 * notice until the ambassador asked why their audience stopped converting.
 *
 * Out-of-range values fall back rather than clamp. A stored 150 is corrupt, not
 * a request for 99% off, and inheriting is the answer that cannot zero an order.
 *
 * This function knows nothing about commission. That is the structural
 * guarantee that the two rates are independent -- stronger than any assertion
 * about a particular pair of values.
 */
export function resolveAmbassadorCustomerDiscount(
  override: unknown,
  programDefaultPercent: number,
): number {
  if (override == null) return programDefaultPercent;
  // An empty or whitespace string is an ABSENT value, not zero. Number("") is
  // 0, so without this an emptied field would resolve to 0% -- the exact
  // silent-strip this function exists to prevent. The API route already maps ""
  // to null, but the rule belongs with the rule, not only at one call site.
  if (typeof override === "string" && override.trim() === "") return programDefaultPercent;
  const value = Number(override);
  if (!Number.isFinite(value) || value < 0 || value >= 100) return programDefaultPercent;
  return value;
}
