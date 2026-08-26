// ---------------------------------------------------------------------------
// "HOW MANY CAN SOMEONE ACTUALLY BUY?" — ONE RULE, ONE PLACE.
//
// Dependency-free on purpose: server pages, client components and admin
// screens all need this answer, and every copy of the rule is a chance to get
// it wrong.
//
// GETTING IT WRONG IS THE MOST REPEATED MISTAKE AGAINST THIS DATABASE. Two
// separate audits have reported the catalogue as mostly sold out by reading
// `products.inventory_quantity` directly — "17 of 38 sold out" (true: 2) and
// "30 products advertising In Stock with zero on hand" (true: 0). For a product
// sold through doses the parent row is NOT the shelf. Parent 0 with stocked
// doses is the normal shape for 86% of the live catalogue.
//
// THE RULE
//
//   product HAS an enabled dose  -> the DEFAULT dose's count is the shelf
//   product has NO enabled dose  -> the parent row's count is the shelf
//
// Default dose = enabled, ordered by (isDefault desc, position asc).
// Available    = on-hand MINUS reserved, floored at zero. A unit somebody is
//                holding mid-checkout is not one this shopper can have.
//
// Mirrors catalog.ts (the customer path) and
// src/lib/sql/canonical-availability.sql (the SQL path). If you change one,
// change all three.
// ---------------------------------------------------------------------------

export interface AvailabilityDose {
  inventoryQuantity?: number | null;
  reservedQuantity?: number | null;
  isDefault?: boolean;
  isEnabled?: boolean;
  position?: number | null;
}

export interface AvailabilityInput {
  inventoryQuantity?: number | null;
  reservedQuantity?: number | null;
  doses?: AvailabilityDose[] | null;
}

export interface AvailabilityResult {
  /** What the card/badge should reflect: the shelf a shopper lands on. */
  available: number;
  /** Every enabled variant added up — a shopper may pick any of them. */
  allVariants: number;
  /** True when the shelf came from a dose rather than the parent row. */
  soldViaDoses: boolean;
  /**
   * Headline reads empty while another variant still has stock. Should be
   * false everywhere; when true the card says Out of Stock over sellable units.
   */
  hidesSellableVariants: boolean;
}

/** Missing, negative, NaN or string counts all become 0 — never NaN on screen. */
function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

/** On-hand minus reserved, floored at zero. */
function sellable(onHand: unknown, reserved: unknown): number {
  return Math.max(0, count(onHand) - count(reserved));
}

/** Enabled doses in the order the storefront would pick a default from. */
function enabledDosesInOrder(doses: AvailabilityDose[] | null | undefined): AvailabilityDose[] {
  return (doses ?? [])
    .filter((dose) => dose?.isEnabled !== false)
    .slice()
    .sort((a, b) => {
      const defaultRank = Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault));
      if (defaultRank !== 0) return defaultRank;
      return count(a.position) - count(b.position);
    });
}

export function resolveHeadlineAvailability(input: AvailabilityInput): AvailabilityResult {
  const doses = enabledDosesInOrder(input?.doses);

  if (doses.length === 0) {
    // Undosed (or every dose disabled): the parent row is the shelf.
    const parent = sellable(input?.inventoryQuantity, input?.reservedQuantity);
    return { available: parent, allVariants: parent, soldViaDoses: false, hidesSellableVariants: false };
  }

  const available = sellable(doses[0].inventoryQuantity, doses[0].reservedQuantity);
  const allVariants = doses.reduce((sum, dose) => sum + sellable(dose.inventoryQuantity, dose.reservedQuantity), 0);

  return {
    available,
    allVariants,
    soldViaDoses: true,
    hidesSellableVariants: available === 0 && allVariants > 0,
  };
}

/** The badge text a shelf count implies. Derived, never typed by hand — a
 *  free-text stock_status is how a product ends up claiming stock it lacks. */
export function availabilityLabel(result: AvailabilityResult): "In Stock" | "Out of Stock" {
  return result.available > 0 ? "In Stock" : "Out of Stock";
}
