// ---------------------------------------------------------------------------
// HOW FAST IS EACH LINE SELLING?
//
// Turns paid order lines into "units sold per inventory line". Pure and
// import-free on purpose: the tricky part is not the SQL, it is that
// order_items and the inventory screen name the same vial two different ways.
//
//   order_items.product_id   "glp-3::9f2c-..."   slug :: dose id
//                            "bacteriostatic-water"  slug alone, dose-less
//   inventory line key       "dose:9f2c-..."  /  "product:<products.id>"
//
// The composite is what checkout writes and what quote-order.ts splits on, so
// this splits it the same way rather than inventing a third convention.
//
// WHY PAID ORDERS AND NOT THE LEDGER. inventory_transactions only began
// recording `order_completed` rows partway through this store's life, so a
// ledger-based pace understates every line that sold before then — and it would
// silently improve over time, which is the worst kind of wrong. Paid orders are
// the demand record and go back to the first sale.
// ---------------------------------------------------------------------------

/** One order line, as loosely typed as PostgREST actually returns it. */
export interface SoldOrderLine {
  product_id: string | null;
  quantity: number | null;
}

/**
 * @param productIdBySlug slug -> products.id, for lines sold without doses.
 *   Built from the inventory rows already in hand, so this needs no extra query.
 *   A slug that is absent is skipped: it belongs to a product that has since
 *   been archived or deleted, and there is no live shelf to warn about.
 */
export function tallyUnitsSoldByLineKey(
  lines: SoldOrderLine[],
  productIdBySlug: Record<string, string>,
): Record<string, number> {
  const tally: Record<string, number> = {};

  for (const line of lines ?? []) {
    const reference = String(line?.product_id ?? "").trim();
    if (!reference) continue;

    const quantity = Number(line?.quantity ?? 0);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    const [slug, doseId] = reference.split("::");

    // A dose id in the composite is the precise answer: strengths are separate
    // shelves with separate costs, so pace must never be summed across them.
    const key = doseId
      ? `dose:${doseId}`
      : productIdBySlug[slug]
        ? `product:${productIdBySlug[slug]}`
        : null;
    if (!key) continue;

    tally[key] = (tally[key] ?? 0) + Math.floor(quantity);
  }

  return tally;
}
