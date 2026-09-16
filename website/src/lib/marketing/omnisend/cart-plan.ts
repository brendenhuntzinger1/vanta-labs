import { isBacWater } from "@/lib/bac-water";
import type { Product } from "@/lib/catalog-types";
import type { RecoveryGiftItem } from "@/lib/cart-recovery-tiers";

/**
 * The cart-shaped decisions the Omnisend hooks and the offer sweep make,
 * with no I/O.
 *
 * Pure on purpose, like contact-payload.ts and reconcile-plan.ts: which cart
 * Omnisend may plan an incentive for, what a cart's lines are worth, and how
 * a gift is described to a customer are all rules that can be pinned against
 * fixed inputs. The server-only halves (hooks.ts, cart-offers.ts) load the
 * rows and push the results; they never add a decision of their own.
 *
 * NO "server-only" IMPORT HERE. That is what makes it unit-testable, and it is
 * also why it must never touch the database or the environment.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * A cart change is reported to Omnisend at most once per cart per ten
 * minutes. The tracking beacon fires on every debounced cart edit, and a
 * shopper comparing doses can produce a dozen in a minute; Omnisend's
 * abandonment timer restarts on every event, so a flood would only ever push
 * the first reminder further away.
 */
export const CART_EVENT_DEBOUNCE_MS = 10 * MINUTE_MS;

/** One `viewed product` per address, product and six hours. */
export const PRODUCT_VIEW_DEBOUNCE_MS = 6 * HOUR_MS;

/**
 * WHEN THE OFFER IS PLANNED. Omnisend's abandoned-cart flow sends its third
 * message 72 hours after the cart event (spec §6), so the incentive is minted
 * close to that dispatch and no earlier: a code minted at hour one would be
 * a code the shopper could learn to wait for. The floor sits well inside the
 * window so a sweep that runs every 30 minutes cannot miss a cart; the
 * ceiling is the same 96 hours after which the in-house ladder gives up.
 */
export const CART_OFFER_MIN_AGE_MS = 36 * HOUR_MS;
export const CART_OFFER_MAX_AGE_MS = 96 * HOUR_MS;

/** The most units one line will claim, whatever the beacon stored. */
const MAX_LINE_QUANTITY = 99;

export type CartOfferCartRow = {
  id: string;
  email: string | null;
  status: string | null;
  items: unknown;
  cart_value_cents: number | null;
  first_seen_at: string | null;
  last_updated_at?: string | null;
};

/** Open statuses, stated here so this module needs nothing server-only. Mirrors CART_STATUS_OPEN. */
const OPEN_STATUSES = new Set(["active", "held"]);

function time(value: string | null | undefined): number {
  const at = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(at) ? at : Number.NaN;
}

/**
 * When the shopper last touched the cart, falling back to first sight for
 * old rows — the same rule the in-house sweep runs its clock on
 * (cart-recovery.ts lastActivityFor), so the two never disagree about a
 * cart's age.
 */
export function cartLastActivityAt(row: Pick<CartOfferCartRow, "first_seen_at" | "last_updated_at">): number {
  const last = time(row.last_updated_at);
  const first = time(row.first_seen_at);
  if (Number.isFinite(last)) return Number.isFinite(first) ? Math.max(last, first) : last;
  return first;
}

export type CartOfferVerdict = { qualifies: true } | { qualifies: false; reason: string };

/**
 * May the offer sweep plan an incentive for this cart?
 *
 * ONE OWNER PER CART is the rule that matters most here: a cart with any
 * in-house stage finishes in-house, and Omnisend never hears about it. The
 * rest is the in-house sweep's own hygiene — open, non-empty, addressed, not
 * already bought — plus the age window the offer is timed to.
 */
export function cartOfferQualifies(input: {
  row: CartOfferCartRow;
  now: number;
  /** Rows in abandoned_cart_emails for this cart. Any at all means in-house. */
  inHouseStages: number;
  /** Paid product orders for the address, whenever. */
  paidOrders: ReadonlyArray<{ at: number }>;
}): CartOfferVerdict {
  const { row, now } = input;
  if (!OPEN_STATUSES.has(String(row.status ?? ""))) return { qualifies: false, reason: "not open" };
  if (!Array.isArray(row.items) || row.items.length === 0) return { qualifies: false, reason: "no items" };
  if (!String(row.email ?? "").trim()) return { qualifies: false, reason: "no email" };
  if (input.inHouseStages > 0) return { qualifies: false, reason: "in-house owned" };

  const firstSeenAt = time(row.first_seen_at);
  if (Number.isFinite(firstSeenAt) && input.paidOrders.some((order) => order.at >= firstSeenAt)) {
    return { qualifies: false, reason: "bought since" };
  }

  const age = now - cartLastActivityAt(row);
  if (!Number.isFinite(age)) return { qualifies: false, reason: "no activity time" };
  if (age < CART_OFFER_MIN_AGE_MS) return { qualifies: false, reason: "too young" };
  if (age > CART_OFFER_MAX_AGE_MS) return { qualifies: false, reason: "stale" };
  return { qualifies: true };
}

/**
 * What a gift product is called in front of a customer.
 *
 * The catalogue name, except that Recon Water is always "Recon Water": the
 * row has traded under three slugs and more than one spelling, and the
 * customer-facing rule is one name. A slug the catalogue cannot name is
 * shown as itself — an ugly label is cosmetic, a withheld gift is not.
 */
export function giftDisplayName(slug: string, name: string | undefined): string {
  if (isBacWater({ slug, name: name ?? "" })) return "Recon Water";
  return String(name ?? "").trim() || slug;
}

/**
 * The gift, in words: "a free GHK-Cu 50mg and a free Recon Water".
 *
 * Each product carries its own article so the sentence reads as a list of
 * things rather than a product code. No emoji, no exclamation mark, no
 * claim about what any of it does.
 */
export function describeRecoveryGift(gifts: ReadonlyArray<RecoveryGiftItem>, names: ReadonlyMap<string, string>): string {
  const parts = gifts.map((item) => {
    const name = giftDisplayName(item.slug, names.get(item.slug));
    return item.quantity > 1 ? `${item.quantity} free ${name}` : `a free ${name}`;
  });
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "$42.99" → 4299. Anything unreadable is 0, never NaN. */
export function priceToCents(value: string | null | undefined): number {
  const parsed = Number(String(value ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : 0;
}

export type PricedCartLine = {
  slug: string;
  variantId: string | undefined;
  title: string;
  variantTitle: string | undefined;
  priceCents: number;
  quantity: number;
  image: string | undefined;
  category: string;
};

/**
 * A cart's lines, priced FROM THE CATALOGUE.
 *
 * The tracking beacon stores whatever the browser posted, so the stored
 * name and price are the shopper's browser's word, not the store's. The
 * event Omnisend receives prices every line as the till would — the dose
 * the line names when the catalogue knows it, the product's price when it
 * does not — and drops a slug that is not a live product entirely, exactly
 * as the in-house recovery email does (cart-recovery.ts recoveryEmailItems).
 */
/** A stored cart line. Only the slug, the dose and the count are read; the rest is the browser's word. */
export type StoredCartLine = {
  slug?: string;
  variantId?: string;
  quantity?: number;
  name?: string;
  unitPrice?: number;
  image?: string;
};

export function priceCartLines(
  items: ReadonlyArray<StoredCartLine>,
  products: ReadonlyArray<Product>,
): PricedCartLine[] {
  const bySlug = new Map(products.map((product) => [product.slug, product]));
  const out: PricedCartLine[] = [];
  for (const item of items) {
    const slug = String(item?.slug ?? "").trim();
    const product = slug ? bySlug.get(slug) : undefined;
    if (!product?.name) continue;
    const quantity = Math.floor(Number(item?.quantity ?? 0));
    if (!Number.isFinite(quantity) || quantity < 1) continue;

    const variantId = String(item?.variantId ?? "").trim() || undefined;
    const dose = variantId ? product.doses?.find((entry) => String(entry.id) === variantId) : undefined;
    const priceCents = dose
      ? priceToCents(dose.salePrice ?? dose.price)
      : priceToCents(product.salePrice ?? product.price);

    out.push({
      slug,
      variantId,
      title: String(product.name),
      variantTitle: dose?.label ? String(dose.label) : undefined,
      priceCents,
      quantity: Math.min(MAX_LINE_QUANTITY, quantity),
      image: product.image ? String(product.image) : undefined,
      category: String(product.category ?? ""),
    });
  }
  return out;
}
