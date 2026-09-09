import { MAX_UNITS_PER_ORDER_LINE } from "@/lib/purchase-limits";

/**
 * WHAT A RESTORED CART IS ALLOWED TO CONTAIN.
 *
 * The recovery email's whole job is to put a shopper back in their cart. That
 * only pays if the cart it puts them in can actually be bought, and until this
 * function existed it frequently could not be:
 *
 *   /api/cart/restore returned the abandoned_carts snapshot verbatim, with no
 *   catalogue read; /api/cart/validate deliberately leaves a line it cannot
 *   find alone ("an unknown line is a lookup gap, not a sold-out product");
 *   and quoteOrder then throws `Invalid product id: <slug>` for that line and
 *   fails THE WHOLE QUOTE.
 *
 * So the one email that reliably drives a shopper back delivered them to a
 * checkout that refused them, quoting a slug. Two live carts were in that state
 * — both repaired by hand the previous day, both reverted the moment the
 * shopper's browser wrote the stale slug again, which is why the fix belongs
 * here rather than in the rows.
 *
 * EVERY RULE BELOW MIRRORS A SPECIFIC quoteOrder REFUSAL. That is the contract:
 * this never hands back a cart quoteOrder would throw on. When quote-order
 * grows a new refusal, it belongs here too.
 *
 * Pure, and the catalogue arrives as an argument, so the rules are testable
 * without a database and the route stays the only thing that reads one.
 */

export interface ReconcileCatalogueDose {
  id: string;
  label: string;
  unitPrice: number;
  image?: string;
}

export interface ReconcileCatalogueEntry {
  slug: string;
  name: string;
  unitPrice: number;
  image?: string;
  doses: ReconcileCatalogueDose[];
}

export interface ReconciledLine {
  slug: string;
  variantId?: string;
  name: string;
  quantity: number;
  unitPrice: number;
  image?: string;
}

export interface DroppedLine {
  /** For display only. The catalogue's name when we have one, else the stored one. */
  name: string;
  reason: "unavailable" | "variant_gone";
}

export interface ReconcileResult {
  items: ReconciledLine[];
  dropped: DroppedLine[];
  repaired: Array<{ from: string; to: string }>;
  /** How many surviving lines had their stored price corrected. */
  repricedCount: number;
}

type StoredLine = {
  slug?: string;
  variantId?: string | null;
  name?: string;
  quantity?: number;
  unitPrice?: number;
  image?: string;
};

/**
 * Reconcile a stored cart snapshot against the live catalogue.
 *
 * `aliases` resolves a slug that no longer exists to the slugs it may have been
 * renamed to — passed in rather than imported so this stays pure and so the
 * only alias family the app actually has (Recon Water's) is named in one place.
 */
export function reconcileRestoredCart(
  stored: ReadonlyArray<StoredLine>,
  catalogue: ReadonlyMap<string, ReconcileCatalogueEntry>,
  aliases: (slug: string) => readonly string[],
): ReconcileResult {
  const items: ReconciledLine[] = [];
  const dropped: DroppedLine[] = [];
  const repaired: Array<{ from: string; to: string }> = [];
  let repricedCount = 0;

  for (const line of stored) {
    const storedSlug = String(line?.slug ?? "").trim();
    // A beacon that posted no slug did not describe a cart line, and there is
    // nothing to tell the shopper about it either.
    if (!storedSlug) continue;

    // A quantity out of the browser is not trustworthy in either direction. A
    // line that rounds away to nothing is simply not a line; one above the
    // per-order ceiling is clamped rather than refused, because the ceiling is
    // what the cart page would have allowed anyway.
    const rawQuantity = Math.floor(Number(line?.quantity ?? 0));
    if (!Number.isFinite(rawQuantity) || rawQuantity < 1) continue;
    const quantity = Math.min(rawQuantity, MAX_UNITS_PER_ORDER_LINE);

    let product = catalogue.get(storedSlug);
    let slug = storedSlug;
    let wasRepaired = false;
    if (!product) {
      for (const candidate of aliases(storedSlug)) {
        const alias = catalogue.get(candidate);
        if (alias) {
          product = alias;
          slug = candidate;
          wasRepaired = true;
          break;
        }
      }
    }

    // MIRRORS quoteOrder's `Invalid product id`. Dropping the line keeps the
    // rest of the cart buyable; leaving it in loses the whole order.
    if (!product) {
      dropped.push({ name: String(line?.name ?? "").trim() || storedSlug, reason: "unavailable" });
      continue;
    }

    const storedVariantId = line?.variantId ? String(line.variantId) : "";
    // A REPAIRED LINE NEVER CARRIES ITS OLD VARIANT ID ACROSS. Dose ids belong
    // to one product, so keeping it would trade a dead slug for a dead dose.
    const dose = storedVariantId
      ? product.doses.find((candidate) => candidate.id === storedVariantId)
      : undefined;

    // MIRRORS "That size of X is no longer available". quoteOrder used to fall
    // back to the default dose here, which charged a 10 mL line at the 30 mL
    // price under a different SKU; it refuses now, so this refuses too rather
    // than handing back a line that will be rejected one screen later.
    if (storedVariantId && !dose) {
      dropped.push({ name: product.name, reason: "variant_gone" });
      continue;
    }

    const unitPrice = dose ? dose.unitPrice : product.unitPrice;
    const storedPrice = Number(line?.unitPrice ?? Number.NaN);
    if (!Number.isFinite(storedPrice) || Math.abs(storedPrice - unitPrice) > 0.001) repricedCount += 1;

    if (wasRepaired) repaired.push({ from: storedSlug, to: slug });

    items.push({
      slug,
      // The name and the image come from the catalogue, never from the stored
      // snapshot: the snapshot is whatever the browser posted to the tracking
      // beacon, and this is rendered back to the customer.
      ...(dose ? { variantId: dose.id } : {}),
      name: product.name,
      quantity,
      unitPrice,
      ...(dose?.image ?? product.image ? { image: dose?.image ?? product.image } : {}),
    });
  }

  return { items, dropped, repaired, repricedCount };
}

/**
 * The sentence the cart page shows when reconciliation changed something.
 *
 * Silence would be worse than the old behaviour, not better: a shopper who
 * clicked "your cart is saved" and found a line missing, with no explanation,
 * has been told the store lost their order. Naming the product and the reason
 * is the difference between an apology and a mystery.
 */
export function describeReconciliation(result: ReconcileResult): string | null {
  if (result.dropped.length === 0) return null;
  const names = result.dropped.map((line) => line.name);
  const list = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const verb = names.length === 1 ? "is" : "are";
  return `${list} ${verb} no longer available, so we could not add ${names.length === 1 ? "it" : "them"} back. Everything else in your cart is ready.`;
}
