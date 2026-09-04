// No `server-only` directive here, matching payment-service.ts (this file is a
// straight lift out of it): the unit tests import the checkout path directly,
// and the transitive supabase-server import already makes a client import a
// build error.
import { getCatalogProductsBySlugs, getStockLevelsBySlugs } from "@/lib/catalog";
import { calculateDiscountAmount } from "@/lib/referral-service";
import { resolveAmbassadorCustomerDiscount } from "@/lib/ambassador-discount";
import { referralQualifies } from "@/lib/referral-qualification";
import { resolvePointsRedemptionCents, resolveStoreCreditCents } from "@/lib/store-credit-redemption";
import { validateCoupon } from "@/lib/coupons";
import { getMembershipPerks, getPointsBalance, isEligibleForBulkSavings, isPriorityMember } from "@/lib/membership";
import { dollarsToPoints, pointsToDollars } from "@/lib/points-math";
import { getAmbassadorProgramSettings } from "@/lib/ambassador-settings";
import { getEffectiveCommissionPercent } from "@/lib/ambassador-commission";
import { getBundleDiscountedUnitPrice } from "@/lib/bundle-pricing";
import { selectPromotionForCart, type BxgyCartLine } from "@/lib/bxgy-engine";
import { offerMinimumMet, peekCustomerOffer, type CustomerOffer } from "@/lib/offers/customer-offers";
import { calculateCouponDiscount } from "@/lib/coupons";
import { getApplicableBxgyPromotions } from "@/lib/bxgy-promotions";
import { calculateShipping, isDomesticCountry, isShippableCountry } from "@/lib/shipping";
import { normalizeUsState } from "@/lib/sales-tax";
import { recordSystemAlert } from "@/lib/monitoring";
import { quoteSalesTax, type ResolvedOrderTax } from "@/lib/tax-provider";
import { calculateShippingProtectionFee } from "@/lib/shipping-protection";
import { isApprovedAmbassadorCustomer } from "@/lib/ambassador-status";
import { calculateBulkSavingsDiscount } from "@/lib/bulk-savings";
import { getHomepageControlConfig, getBulkSavingsControlConfig, getPaymentMethodsConfig, getCardProcessingFeeConfig, getShippingConfig, getReferralProgramConfig, getCouponPolicyConfig, getProfitSettings } from "@/lib/admin-control";
import { computeProfit, meetsFloor, resolveCustomerDiscount } from "@/lib/profit-engine";
import { calculateCardProcessingFee, getPaymentMethodById, isManualPaymentMethod, type PaymentMethodConfig } from "@/lib/payment-methods";
import { supabaseAdmin } from "@/lib/supabase-server";

import type { CartItemInput, CustomerInput } from "@/lib/payment-types";

// -------------------------------------------------------------------------
// quoteOrder — the store's ONE authoritative pricing pass.
//
// Lifted verbatim out of createCheckoutSession (payment-service.ts) so that a
// second checkout lane can price an order with byte-identical math instead of
// growing a parallel copy that silently drifts. Nothing about the numbers
// changed in the extraction; `mode: "full"` is exactly what the card checkout
// has always computed.
//
// The second caller is the Apple Pay express lane, which has a problem the card
// lane does not: at the moment the wallet sheet is armed there is NO shipping
// address, but Apple still needs an opening amount. `mode: "address_optional"`
// answers that by resolving shipping and tax to 0 and reporting the
// address-INDEPENDENT total (A). The express lane then locks shipping (S) and
// tax (T) through the wallet's own address callback and charges A + S + T.
// Because the profit guard runs with $0 shipping collected in that mode it is
// strictly HARSHER than the full quote — a cart that would clear the floor once
// real shipping is collected can be refused early. That direction is deliberate:
// an early refusal hides the express button and the shopper still has the normal
// checkout, whereas the reverse would let a below-floor order through.
// -------------------------------------------------------------------------

export type QuoteMode = "full" | "address_optional" | "destination_only" | "preview";

export interface ServerProduct {
  id: string;
  name: string;
  price: number;
  stockStatus: string;
  variantId?: string;
  variantLabel?: string;
  variantSku?: string;
}

export interface QuoteOrderInput {
  items: CartItemInput[];
  customer: CustomerInput;
  referralCode?: string;
  couponCode?: string;
  customerUserId?: string;
  pointsToRedeem?: number;
  shippingProtection?: boolean;
  paymentMethod?: string;
  /**
   * Client-claimed total, checked against the server's own once it is known.
   * Only UNDERpayment is rejected — see the guard below. The express lane never
   * sends one (the wallet sheet's amount comes FROM this quote, not into it).
   */
  expectedTotal?: number;
  /**
   * A one-time customer offer token, from the link in their email.
   *
   * Opaque here. It is looked up server-side against customer_offers and is
   * never trusted for anything the client says about it — see the free-unit
   * block below, which is the only place an order can acquire a $0 line.
   */
  offerToken?: string;
  /**
   * "full" (card checkout / express authorize): the whole contact is known and
   * validated, shipping + tax are priced.
   * "address_optional" (express session create): no address yet, shipping + tax
   * are 0 and `addressIndependentCents` carries the wallet sheet's opening
   * amount.
   * "preview" (the cart drawer and the checkout summary, via
   * /api/checkout/quote): the shopper is still filling the form, so the state
   * may not be chosen yet and there is no contact at all. Shipping and tax are
   * priced from whatever destination IS known — a US address with no state
   * resolves tax to the ordinary `no_state` outcome rather than throwing, which
   * is exactly what the summary already renders as "Enter address". Charges
   * nothing and reserves nothing, like every other mode here; it exists so the
   * numbers a shopper reads come from THIS function instead of a second one
   * that has to be kept in step with it.
   * "destination_only" (express shipping callback): Apple redacts the street
   * address and the cardholder name until authorization, so only the
   * DESTINATION is validated — country/state, which is all shipping and tax
   * actually depend on. Contact identity is validated later, at authorize,
   * before any money moves.
   */
  mode: QuoteMode;
}

/** One labelled money row, in cents, for a wallet payment sheet. */
export interface QuoteDisplayLineItem {
  label: string;
  amountCents: number;
}

export interface QuoteOrderLine {
  product: ServerProduct;
  quantity: number;
  baseUnitPrice: number;
  /**
   * True for the free unit a one-time customer offer added. The customer did
   * not buy it, so it must never count as a bought unit anywhere that counts
   * units — see toPromotionCartLines. Inventory, order_items and COGS still
   * see it, because it ships.
   */
  gift?: true;
}

export interface ValidatedReferral {
  ambassadorId: string;
  code: string;
  discountPercent: number;
  commissionPercent: number;
  ambassadorName: string;
  ambassadorEmail: string | null;
  ambassadorAuthUserId: string | null;
}

export interface QuoteResult {
  lineItems: QuoteOrderLine[];
  subtotal: number;
  shipping: number;
  discountAmount: number;
  bulkDiscountTier: string | null;
  isPriorityOrder: boolean;
  taxQuote: ResolvedOrderTax;
  taxAmount: number;
  referral: ValidatedReferral | null;
  couponCode: string | null;
  isBuy3Get1Active: boolean;
  /**
   * The one-time offer this quote priced a free unit for, if any.
   *
   * ADVISORY, NOT A GRANT. quoteOrder takes no lock and reserves nothing — no
   * order exists yet to reserve against. Order creation must call
   * reserveCustomerOffer() with this token and REFUSE THE ORDER if the reserve
   * comes back empty, or two concurrent checkouts both ship a free vial. Same
   * contract as appliedPromotionLimits below.
   */
  appliedOffer: { token: string; offerKey: string; rewardKind: string; description: string } | null;
  /** Id of the Buy X Get Y promotion that priced this order, for orders.promotion_id. */
  appliedPromotionId: string | null;
  /** Its customer-facing name, for receipts and admin. */
  appliedPromotionName: string | null;
  /**
   * The limits that promotion carries, or null when it carries none.
   *
   * Present so order creation can claim a redemption atomically without
   * re-reading the promotion config it has already resolved here. Null means
   * "nothing to claim" — an unlimited promotion needs no slot.
   */
  appliedPromotionLimits: { maxRedemptions: number | null; perCustomerLimit: number | null } | null;
  storeCreditRedeemedCents: number;
  pointsRedeemed: number;
  pointsDiscountAmount: number;
  shippingProtectionFee: number;
  /** Total before the card processing fee. */
  expectedTotal: number;
  /** The configured method list this quote resolved against. */
  paymentMethods: PaymentMethodConfig[];
  selectedMethod: PaymentMethodConfig;
  isManualPayment: boolean;
  cardFee: { amount: number; percentage: number };
  /** expectedTotal + cardFee.amount — what the card lane charges. */
  finalTotal: number;
  /** Per-line COGS in cents (null when no cost is on record). */
  unitCostCentsForLine: (line: QuoteOrderLine) => number | null;
  /**
   * The address-independent amount in cents (merchandise − discounts − credit +
   * protection + service fee), i.e. `A`. In "full" mode this equals
   * round(finalTotal * 100); in "address_optional" mode shipping and tax are 0
   * so it is the wallet sheet's opening total.
   */
  addressIndependentCents: number;
  /** Server-built breakdown the wallet sheet renders verbatim. */
  displayLineItems: QuoteDisplayLineItem[];
}

// Parse a display price string ("$44.99") to a number, FAILING CLOSED on
// anything that is not a real, positive price.
//
// The NaN/negative cases were already refused. Zero was not — and zero is not
// an exotic input here, it is the DEFAULT: `products.price_cents` is
// `integer not null default 0`, and the admin save path writes
// `Math.max(0, Math.round(input.priceCents ?? 0))`, so a product published
// before its price is typed in carries 0. An unparseable string ("TBD",
// "call for price", an empty cell in a CSV import) strips to "" and
// `Number("")` is also 0, so those landed in exactly the same place.
//
// Nothing downstream treated that as an error. The order priced the line at
// $0.00 and the customer received real product for the cost of postage.
//
// The only thing that had been stopping it was the MARGIN GUARD, which charges
// the order `profitSettings.worstCaseUnitCost` when no per-SKU cost is on file
// and refuses a negative-profit order. That is an estimation control the owner
// can edit in Control Center: setting worst-case unit cost to 0 — a change
// about REPORTING — silently made every unpriced published product free.
// Reproduced end-to-end before this fix.
//
// A purchasable line must have a price above zero. Free merchandise in this
// store is expressed as a DISCOUNT on a priced line (bundle, Buy-3-Get-1,
// coupon), never as a $0 catalogue price, and neither membership nor
// replacement orders are priced through this function.
function parseProductPrice(raw: string): number {
  const value = Number(String(raw).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("This product has an invalid price and can't be purchased right now.");
  }
  return value;
}

export function sanitizeText(value: string) {
  return value.replace(/[<>]/g, "").trim();
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

// Destination-only checks: everything shipping and sales tax depend on, and
// nothing else. Split out of validateCustomer so the wallet shipping callback
// (which only ever sees a redacted country/state/city/postal contact) can run
// exactly the same destination rules the card lane does.
export function validateDestination(customer: Pick<CustomerInput, "country" | "state">) {
  // The store ships only to the US and Canada — reject anything else server-side
  // so it can't be bypassed even if the client country selector is tampered with.
  if (!isShippableCountry(customer.country)) {
    throw new Error("We currently ship only to the United States and Canada.");
  }

  // US orders must carry a recognizable state: sales tax is resolved from it,
  // so a crafted request without one could dodge tax in a nexus state. The
  // checkout UI already requires this; the server is the authority.
  if (isDomesticCountry(customer.country) && !normalizeUsState(customer.state)) {
    throw new Error("Please select the state for your shipping address.");
  }
}

export function validateCustomer(customer: CustomerInput) {
  if (!customer.email || !customer.email.includes("@")) {
    throw new Error("Invalid email address");
  }

  if (
    !customer.fullName ||
    !customer.address ||
    !customer.city ||
    !customer.postalCode ||
    !customer.country
  ) {
    throw new Error("Incomplete customer details");
  }

  validateDestination(customer);
}

// THE ORDER'S BUY-X-GET-Y PROMOTION.
//
// This used to be a hand-written "every 4th item is free" loop that had to
// match, line for line, an identical loop in cart-context.tsx. Both now call
// selectPromotionForCart in bxgy-engine.ts with the same two prices per line,
// so the server total and the cart preview cannot drift — the thing the
// "Altered total detected" guard in payment-service.ts exists to catch.
//
// Buy 3 Get 1 is one of those configurations and prices exactly as it always
// did: floor(n / 4) cheapest units free, across mixed products and quantities.
function toPromotionCartLines(
  lineItems: QuoteOrderLine[],
): BxgyCartLine[] {
  // THE GIFT IS NOT A BOUGHT UNIT. The engine expands every line into units,
  // keeps anything priced >= 0 and rewards the cheapest, so a $0 gift line was
  // the first unit it picked — a basket that had earned Buy 3 Get 1 lost the
  // whole reward to a unit the store was giving away anyway. It is filtered
  // here, at the one door into the engine, rather than by price: a genuinely
  // free catalogue item is still a unit the customer chose.
  return lineItems.filter((line) => !line.gift).map((line) => ({
    // `product.id` is `slug` or `slug::doseId`; eligibility is per product.
    slug: line.product.id.split("::")[0],
    listUnitPrice: line.baseUnitPrice,
    // product.price already carries the quantity-bundle discount — see the
    // getBundleDiscountedUnitPrice call where lineItems is built.
    bundledUnitPrice: line.product.price,
    quantity: line.quantity,
  }));
}

async function validateReferralCode(
  code: string | undefined,
  programDefaultDiscountPercent: number,
): Promise<ValidatedReferral | null> {
  const normalizedCode = code?.trim().toUpperCase();

  if (!normalizedCode) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("ambassadors")
    .select("id, name, email, auth_user_id, referral_code, commission_percent, customer_discount_percent, status")
    .eq("referral_code", normalizedCode)
    .maybeSingle();

  if (error) {
    console.error("Referral lookup failed:", error);
    throw new Error("Unable to verify referral code");
  }

  if (!data) {
    throw new Error("Invalid referral code");
  }

  if (data.status !== "approved") {
    throw new Error("That referral code is not active");
  }

  const discountPercent = resolveAmbassadorCustomerDiscount(
    data.customer_discount_percent,
    programDefaultDiscountPercent,
  );

  return {
    ambassadorId: data.id,
    code: data.referral_code.toUpperCase(),
    discountPercent,
    commissionPercent: Number(data.commission_percent ?? 10),
    ambassadorName: data.name,
    ambassadorEmail: data.email ?? null,
    ambassadorAuthUserId: data.auth_user_id ?? null,
  };
}

/**
 * Per-line COGS in cents, or null when no cost is on record.
 *
 * Three cases:
 * 1. HAS dose rows, dose cost present → use dose cost
 * 2. HAS dose rows, dose cost absent → return null (never use stale parent cost)
 * 3. NO dose rows → use parent cost (it is authoritative for dose-less products)
 *
 * The parent cost (`products.product_cost_cents`) holds costs inherited from
 * EvoLabs, the former third-party fulfilment provider, superseded by per-vial
 * landed costs in sql/product-cogs.sql. The parent is SET ONLY FOR PRODUCTS THAT
 * HAVE NO DOSE ROWS AT ALL (per product-cogs.sql). On 36 of 38 published
 * products with doses, the parent figure is 1.4x-6.8x the true dose cost.
 *
 * Returning null for missing dose costs (when doses exist) makes computeOrderProfit
 * set `hasEstimatedCost`, so the order reports COGS as ESTIMATED. A visible
 * estimate beats a confident wrong number.
 */
export function resolveUnitCostCents(
  slug: string,
  variantId: string | undefined,
  unitCostByDoseId: Map<string, number>,
  unitCostBySlug: Map<string, number>,
  slugsWithDoses: Set<string>,
): number | null {
  const doseCost = variantId ? unitCostByDoseId.get(variantId) : undefined;
  if (doseCost && doseCost > 0) return Math.round(doseCost * 100);
  // HAS doses but no cost on the chosen one: refuse to substitute. The parent
  // figure here is an inherited EvoLabs seed cost, 1.4x-6.8x the true landed
  // cost, and a confident wrong number is worse than a visible estimate.
  if (slugsWithDoses.has(slug)) return null;
  // NO doses at all: the parent cost is the ONLY cost this product has, and
  // product-cogs.sql sets it for exactly this case. Using it is correct.
  const slugCost = unitCostBySlug.get(slug);
  return slugCost && slugCost > 0 ? Math.round(slugCost * 100) : null;
}

export async function quoteOrder(input: QuoteOrderInput): Promise<QuoteResult> {
  // Whether a destination is known well enough to price shipping and tax.
  const destinationKnown = input.mode !== "address_optional";

  if (input.mode === "full") {
    validateCustomer(input.customer);
  } else if (input.mode === "destination_only") {
    validateDestination(input.customer);
  } else if (input.mode === "preview") {
    // A preview refuses an unshippable COUNTRY — quoting postage to a place the
    // store does not serve would be a made-up number — but deliberately does
    // not require the state that validateDestination insists on. That rule
    // guards a real charge from dodging tax in a nexus state; a preview places
    // no order, and a shopper who has not reached the state selector yet still
    // needs to see what their gift is doing to the total.
    if (!isShippableCountry(input.customer.country)) {
      throw new Error("We currently ship only to the United States and Canada.");
    }
  }

  const sanitizedItems = input.items.map((item) => ({
    id: sanitizeText(item.id),
    quantity: Number(item.quantity),
  }));

  if (sanitizedItems.length === 0) {
    throw new Error("Cart is empty");
  }

  if (
    sanitizedItems.some(
      (item) =>
        !item.id ||
        item.quantity < 1 ||
        item.quantity > 99 ||
        !Number.isInteger(item.quantity),
    )
  ) {
    throw new Error("Invalid cart payload");
  }

  // Cap total units per order server-side so a crafted request can't place an
  // absurd order (denial-of-inventory / oversized order) even for untracked SKUs.
  //
  // These two caps arrived on main in the launch-audit batch, where they lived
  // inline in createCheckoutSession. They belong HERE instead: quoteOrder is the
  // single entry point for both the card lane and the Apple Pay express lane, and
  // express accepts a client-supplied cart too — leaving them on the card path
  // alone would have made express the bypass.
  const totalUnits = sanitizedItems.reduce((sum, item) => sum + item.quantity, 0);
  if (totalUnits > 500) {
    throw new Error("Order exceeds the maximum quantity. Please contact us for bulk orders.");
  }

  // THE OFFER IS RESOLVED BEFORE THE CATALOGUE READ so its product is fetched
  // in the same round trip as everything else — the free unit needs a real
  // price row for its COGS, a real stock level, and a real dose id, exactly as
  // a bought unit does.
  //
  // A quote with no known email cannot resolve one at all: the offer is bound
  // to an address, and the express lane's "address_optional" pass has none yet.
  // That pass prices the cart WITHOUT the gift, and the full quote at authorize
  // adds it — which is the safe direction, since the wallet sheet then never
  // shows a total lower than the one actually charged.
  const offer: CustomerOffer | null = input.offerToken
    ? await peekCustomerOffer({ token: input.offerToken, email: input.customer.email ?? "" })
    : null;

  const requestedSlugs = Array.from(new Set([
    ...sanitizedItems.map((item) => item.id.split("::")[0]),
    ...(offer?.product_slug ? [offer.product_slug] : []),
  ]));
  const catalogProducts = await getCatalogProductsBySlugs(requestedSlugs);
  // Raw stock, read separately and server-side only. The catalog objects above
  // are the same ones handed to client components, so they carry no counts —
  // see getStockLevelsBySlugs. Keyed by slug for a product, dose id for a variant.
  const stockLevels = await getStockLevelsBySlugs(requestedSlugs);

  // Real per-SKU cost (COGS) for the profit floor. The catalog select omits cost,
  // so fetch it directly here — the profit guard must price against the ACTUAL
  // product/dose cost, not a single flat worst-case assumption (which let a
  // deeply-discounted order on a high-cost SKU finalize below true break-even).
  const { data: costRows } = await supabaseAdmin
    .from("products")
    .select("slug, product_cost_cents, product_doses(id, product_cost_cents)")
    .in("slug", requestedSlugs);
  const unitCostBySlug = new Map<string, number>();
  const unitCostByDoseId = new Map<string, number>();
  const slugsWithDoses = new Set<string>();
  for (const row of (costRows ?? []) as Array<{ slug: string; product_cost_cents: number | null; product_doses: Array<{ id: string; product_cost_cents: number | null }> | null }>) {
    const productCostCents = Number(row.product_cost_cents ?? 0);
    if (productCostCents > 0) unitCostBySlug.set(String(row.slug), productCostCents / 100);
    for (const dose of row.product_doses ?? []) {
      slugsWithDoses.add(String(row.slug));
      const doseCostCents = Number(dose.product_cost_cents ?? 0);
      if (doseCostCents > 0) unitCostByDoseId.set(String(dose.id), doseCostCents / 100);
    }
  }

  // Fetch the homepage/promotions control once, up front, because the bundle
  // discount below is applied while building line items (before the main config
  // Promise.all). Bundle rates are admin-editable; the client preview reads the
  // same config from /api/catalog/promotions so the charge always matches.
  const homepageControlConfig = await getHomepageControlConfig();
  const bundleConfig = homepageControlConfig.bundleConfig;
  const productsById = new Map<string, ServerProduct>(
    catalogProducts.map((product) => [
      product.slug,
      {
        id: product.slug,
        name: product.name,
        price: parseProductPrice(product.price),
        stockStatus: product.stockStatus,
      },
    ]),
  );

  const lineItems: QuoteOrderLine[] = sanitizedItems.map((item) => {
    const [slug, variantId] = item.id.split("::");
    const baseProduct = productsById.get(slug);

    if (!baseProduct) {
      throw new Error(`Invalid product id: ${item.id}`);
    }

    const catalogProduct = catalogProducts.find((product) => product.slug === slug);
    const selectedDose = variantId
      ? catalogProduct?.doses?.find((dose) => dose.id === variantId)
      : catalogProduct?.doses?.find((dose) => dose.isDefault) ?? catalogProduct?.doses?.[0];

    const baseUnitPrice = selectedDose
      ? parseProductPrice(selectedDose.salePrice ?? selectedDose.price)
      : baseProduct.price;

    // "Bundle & Save" (2 vials = 5% off, 3+ = 8% off) is applied here, at the
    // authoritative price the server charges, so it's correct no matter what
    // the client displayed - see getBundleDiscountedUnitPrice's callers in
    // cart-context.tsx and product-detail-client.tsx for the matching client
    // preview using the exact same shared formula.
    const product: ServerProduct = {
      ...baseProduct,
      // Carry the RESOLVED dose in the line id, not whatever the cart sent.
      //
      // A cart line added from the catalogue grid has no `::<doseId>` suffix —
      // ProductCard's Add to Cart has no dose picker — so `item.id` is the bare
      // slug. This block already resolves the default dose for pricing and for
      // the oversell guard, but the id was passed through untouched, and that id
      // becomes order_items.product_id, which is what parseOrderItemRef() splits
      // to decide WHICH ROW inventory moves on. The result was a genuine
      // oversell: a grid purchase reserved and decremented `products`, while the
      // storefront reads the dose row, so the shelf never went down and the same
      // two units could be sold indefinitely.
      //
      // Rebuilding the id here fixes it at the single point where the dose is
      // known, and it repairs carts that were already saved with a bare slug —
      // no shopper has to re-add anything.
      id: selectedDose ? `${slug}::${selectedDose.id}` : item.id,
      price: getBundleDiscountedUnitPrice(baseUnitPrice, item.quantity, bundleConfig),
      stockStatus: selectedDose?.stockStatus ?? baseProduct.stockStatus,
      variantId: selectedDose?.id,
      variantLabel: selectedDose?.label,
      variantSku: selectedDose?.sku,
    };

    if (product.stockStatus === "Reserved") {
      throw new Error(`Product is unavailable: ${product.name}`);
    }

    if (product.stockStatus === "Out of Stock") {
      throw new Error(`Product is out of stock: ${product.name}`);
    }

    // Oversell guard. This ONLY fires when a real, positive stock count is on
    // record for the item being purchased (a specific dose's count if a variant
    // was chosen, otherwise the product-level count).
    //
    // A count of 0 is handled UPSTREAM, in resolveStockStatus: with tracking on
    // it resolves to "Out of Stock" and the check above has already rejected
    // the line. That matters because the storefront and checkout then agree --
    // a shopper never adds something labelled In Stock only to be refused at
    // the last step. With tracking off, 0 still means "not tracked" and the
    // catalogue stays fully purchasable, exactly as before.
    const trackedInventory = selectedDose
      ? stockLevels.get(selectedDose.id)
      : catalogProduct
        ? stockLevels.get(catalogProduct.slug)
        : undefined;
    if (typeof trackedInventory === "number" && Number.isFinite(trackedInventory) && trackedInventory > 0) {
      if (item.quantity > trackedInventory) {
        // Deliberately does NOT name the count. Stock depth is the owner's
        // commercial information, and an error message that reports it turns
        // checkout into a free inventory API — a competitor could binary-search
        // the exact figure for every line in the catalogue. The shopper is told
        // what to do instead, which is the only part they needed.
        throw new Error(
          `We can't ship that many of ${product.name} right now. Please lower the quantity and try again.`,
        );
      }
    }

    return {
      product,
      quantity: item.quantity,
      baseUnitPrice,
    };
  });

  const subtotal = roundMoney(
    lineItems.reduce(
      (sum, line) => sum + line.product.price * line.quantity,
      0,
    ),
  );

  // Retail subtotal at FULL (pre-bundle) unit prices, and the dollars the
  // quantity "Bundle & Save" tiers already granted inside `subtotal`. With
  // bundle stacking OFF (the default), every percentage discount is computed
  // on the full base and must BEAT the bundle savings to apply — the customer
  // gets exactly ONE discount per order: bundle pricing or the better promo,
  // never both. The admin can restore legacy stacking in the Control Center.
  const fullSubtotal = roundMoney(
    lineItems.reduce((sum, line) => sum + line.baseUnitPrice * line.quantity, 0),
  );
  const bundleStacking = homepageControlConfig.bundleStacking === true;
  const quantityBundleSavings = bundleStacking ? 0 : roundMoney(Math.max(0, fullSubtotal - subtotal));
  const discountBase = bundleStacking ? subtotal : fullSubtotal;

  // ---------------------------------------------------------------------
  // THE FREE UNIT.
  //
  // Added HERE, after subtotal, fullSubtotal and discountBase are all fixed,
  // and that placement is the whole design:
  //
  //   * the MINIMUM is tested against what the customer is actually paying,
  //     before the gift — so the gift can never help the order qualify for
  //     the gift;
  //   * no percentage discount, bundle tier or Buy X Get Y promotion can see
  //     the extra line, so none of them can be enlarged by it;
  //   * it IS in lineItems, so inventory reserves it, order_items records it,
  //     and unitCostCentsForLine books its COGS against profit — the customer
  //     pays nothing and the store still counts what it cost.
  //
  // Everything below is decided server-side from the customer_offers row. The
  // client sends an opaque token and nothing else; it cannot name the product,
  // the quantity or the price.
  let appliedOffer: QuoteResult["appliedOffer"] = null;
  // Set here, consumed by the shipping calculation below. Declared out here so
  // the two cannot drift apart: the gift is decided in one place, and shipping
  // reads the decision rather than re-deriving it.
  let offerGrantsFreeShipping = false;

  // FREE SHIPPING IS THE ABSENCE OF A FEE, not a line.
  //
  // So it joins the two conditions that already zero shipping — a bulk-savings
  // tier and a membership perk — rather than inventing a parallel path. Nothing
  // downstream needs to know an offer was involved; the order simply has no
  // shipping charge, exactly as a member's would not.
  //
  // Worth knowing what this is worth: the store already ships free over $200
  // domestic, so this grants $15 (or $25 to the rest of North America) on
  // orders BELOW that and nothing at all above it. The catalogue's minimum is
  // set with that ceiling in mind — see OFFER_CATALOG.
  // The percentage half of a combined gift, in dollars. Fed to
  // resolveCustomerDiscount through the COUPON slot further down, so it obeys
  // the store's single-best-discount rule exactly as a coupon does rather than
  // inventing a rule of its own — it competes, and it can lose to a better
  // membership or ambassador price. The free-shipping half is decided above and
  // is never in that race, so the worst case is "keeps the better discount, and
  // still gets free shipping".
  let offerPercentDiscount = 0;

  // ONE BLOCK FOR EVERY KIND. A reward is up to three grants — a $0 product
  // line, a waived shipping fee, a percentage — and each kind is a subset:
  //   free_product          line
  //   free_shipping                shipping
  //   free_shipping_percent        shipping + percent
  //   percent                                 percent
  //   free_product_percent  line            + percent
  // Each grant is decided once, below, from the stored row; the kind only says
  // which of the three to attempt. Nothing applies under the minimum.
  if (offer && input.offerToken && offerMinimumMet(offer, Math.round(subtotal * 100))) {
    const kind = String(offer.reward_kind);
    const wantsProduct = kind === "free_product" || kind === "free_product_percent";
    const wantsShipping = kind === "free_shipping" || kind === "free_shipping_percent";
    const percent = kind === "free_shipping_percent" || kind === "percent" || kind === "free_product_percent"
      ? Number(offer.percent_off ?? 0)
      : 0;

    let productDescription: string | null = null;
    if (wantsProduct) {
      const offerProduct = catalogProducts.find((candidate) => candidate.slug === offer.product_slug);
      const offerDose = offerProduct
        ? (offer.variant_id
            ? offerProduct.doses?.find((dose) => dose.id === offer.variant_id)
            : offerProduct.doses?.find((dose) => dose.isDefault) ?? offerProduct.doses?.[0])
        : undefined;
      const offerStock = offerProduct
        ? (offerDose ? stockLevels.get(offerDose.id) : stockLevels.get(offerProduct.slug))
        : undefined;
      const offerStockStatus = offerDose?.stockStatus ?? offerProduct?.stockStatus;

      // A gift we cannot ship is worse than no gift: it would be promised in
      // the email, shown in the cart, and then oversold. Out of stock means the
      // product half simply does not apply to this order and the token stays
      // spendable for later.
      //
      // stockLevels carries only TRACKED rows (getStockLevelsBySlugs), so a
      // number here is a real count and 0 means "tracked, and there are none".
      // This used to test `offerStock > 0 && offerStock < 1`, which no integer
      // count can satisfy, so a tracked-but-empty gift whose catalogue status
      // had not caught up was added anyway — and reserve_inventory then refused
      // the whole order over a unit the shopper never asked for.
      const shippable = Boolean(offerProduct)
        && offerStockStatus !== "Out of Stock"
        && offerStockStatus !== "Reserved"
        && !(typeof offerStock === "number" && Number.isFinite(offerStock) && offerStock <= 0);

      if (offerProduct && shippable) {
        lineItems.push({
          product: {
            ...offerProduct,
            id: offerDose ? `${offerProduct.slug}::${offerDose.id}` : offerProduct.slug,
            // The only place in this function a price is forced rather than
            // resolved. It is not a discount on a real price — it is the price.
            price: 0,
            stockStatus: offerDose?.stockStatus ?? offerProduct.stockStatus,
            variantId: offerDose?.id,
            variantLabel: offerDose?.label,
            variantSku: offerDose?.sku,
          },
          quantity: 1,
          // Zero here too, so fullSubtotal-style reads stay honest if this line
          // is ever included in one: the customer was never charged for it and
          // was never "discounted" from anything.
          baseUnitPrice: 0,
          gift: true,
        });
        productDescription = offerDose?.label ? `${offerProduct.name} (${offerDose.label})` : offerProduct.name;
      }
    }

    if (wantsShipping) offerGrantsFreeShipping = true;
    // Priced off discountBase, the same base every other percentage uses, so
    // a gift's percentage and a coupon of the same size are worth the same.
    if (percent > 0) offerPercentDiscount = calculateCouponDiscount(discountBase, "percent", percent);

    // The description names what was actually granted, in the order the
    // customer reads it: product, then shipping, then the percentage.
    const parts = [
      productDescription,
      wantsShipping ? "Free shipping" : null,
      percent > 0 ? `${percent}% off` : null,
    ].filter((part): part is string => Boolean(part));
    if (parts.length > 0) {
      appliedOffer = {
        token: input.offerToken,
        offerKey: offer.offer_key,
        rewardKind: kind,
        description: parts.join(" + "),
      };
    }
  }

  const [applicablePromotions, bulkSavingsConfig, bulkSavingsEligible, isPriorityOrder, shippingConfig, memberPerks, referralProgram, couponPolicy] = await Promise.all([
    // Switched on, inside their schedule, and not used up — resolved once,
    // here, so the same list prices the order and the coupon rules read it.
    // The customer's email is what makes a per-customer usage limit
    // enforceable; an anonymous quote simply has no per-customer history to
    // check against.
    getApplicableBxgyPromotions(
      { customerEmail: input.customer.email },
      { promotions: homepageControlConfig.bxgyPromotions },
    ),
    getBulkSavingsControlConfig(),
    input.customerUserId ? isEligibleForBulkSavings(input.customerUserId) : Promise.resolve(false),
    input.customerUserId ? isPriorityMember(input.customerUserId) : Promise.resolve(false),
    getShippingConfig(),
    input.customerUserId
      ? getMembershipPerks(input.customerUserId)
      : Promise.resolve({ isActiveMember: false, tierSlug: "free", memberDiscountPercent: 0, freeShipping: false, pointsPerDollar: 1, storeCreditBalanceCents: 0, storeCreditMinOrderCents: 0 }),
    getReferralProgramConfig(),
    getCouponPolicyConfig(),
  ]);
  // No service/handling fee is ever charged — customers pay merchandise (minus
  // discounts) + shipping + sales tax only.
  const bulkSavingsResult = calculateBulkSavingsDiscount(discountBase, bulkSavingsEligible, bulkSavingsConfig);
  // THE ORDER'S BUY-X-GET-Y PROMOTION — at most one, the one worth the most.
  //
  // Each promotion is priced against its OWN valuation of a rewarded unit
  // (full list price, or the bundle-discounted price when this promotion or the
  // store-wide bundleStacking switch says the two may combine), which is why
  // each line carries both prices and the engine picks.
  //
  // The winner then becomes `bundleDiscount` in resolveCustomerDiscount below,
  // the exact input Buy 3 Get 1 has always fed it — so every downstream rule
  // (a referral cannot stack on it, a coupon competes with it unless the admin
  // allows stacking, the profit guard can peel it off) applies unchanged to all
  // five new promotions without a line of new policy.
  const selectedPromotion = selectPromotionForCart(
    toPromotionCartLines(lineItems),
    applicablePromotions,
    { bundleStacking },
  );
  const promotionDiscount = selectedPromotion?.application.discountAmount ?? 0;
  const appliedPromotionId = selectedPromotion?.promotion.id ?? null;
  const appliedPromotionName = selectedPromotion?.promotion.name ?? null;
  const appliedPromotionLimits = selectedPromotion
    && (selectedPromotion.promotion.maxRedemptions !== null || selectedPromotion.promotion.perCustomerLimit !== null)
    ? {
      maxRedemptions: selectedPromotion.promotion.maxRedemptions,
      perCustomerLimit: selectedPromotion.promotion.perCustomerLimit,
    }
    : null;
  // Kept under its original name because payment-service, the express lane and
  // the referral-exclusivity suite all read it. It has always meant "a free/
  // reduced-price item promotion priced this order"; it now means that for any
  // of the six, not only Buy 3 Get 1.
  const isBuy3Get1Active = promotionDiscount > 0;
  /** This promotion says a coupon may be added on top of it. */
  const promotionAllowsCouponStacking = isBuy3Get1Active && (selectedPromotion?.promotion.stackWithCoupon ?? false);

  const couponEntered = Boolean(input.couponCode?.trim());
  const referralCodeEntered = Boolean(input.referralCode?.trim());

  // Referral program master switch. When off, an entered code is rejected
  // explicitly (rather than silently ignored) so the customer never sees a
  // total that differs from the preview.
  if (referralCodeEntered && !referralProgram.enabled) {
    throw new Error("The referral program is currently unavailable. Remove the code to continue.");
  }

  // A referral only counts when the customer has visibly applied it (create-
  // session no longer reads the cookie). If a code that was valid when applied
  // has since gone stale — the ambassador was removed, or the code was changed —
  // DROP it to null rather than throwing: a stale referral must never hard-block
  // a legitimate sale. Commission is only attributed for a currently-approved
  // code (validateReferralCode rejects any status != approved).
  let referral: ValidatedReferral | null = null;
  if (referralProgram.enabled) {
    try {
      referral = await validateReferralCode(input.referralCode, referralProgram.discountPercent);
    } catch {
      referral = null;
    }
  }

  // Coupons never combine with a referral code or Buy 3 Get 1 unless the admin
  // has explicitly enabled stacking.
  if (!couponPolicy.allowStacking) {
    if (referral && couponEntered) {
      throw new Error("Coupon codes cannot be combined with a referral code. Remove one to continue.");
    }
    // A promotion may opt into coupon stacking on its own (stackWithCoupon),
    // in which case the coupon is welcome and the two combine downstream.
    if (isBuy3Get1Active && couponEntered && !promotionAllowsCouponStacking) {
      throw new Error(`Coupon codes cannot be combined with ${appliedPromotionName ?? "this promotion"}. Remove the coupon code to continue.`);
    }
  }

  // BELOW THE PROGRAMME MINIMUM THE REFERRAL IS INERT, NOT FATAL.
  //
  // This used to THROW, which made an ambassador's own link a checkout blocker
  // for any basket under the minimum: the cart announced her discount, applied
  // none, still sent the code, and the pay button returned HTTP 400 naming a
  // minimum the shopper had never been shown. Production carried 75 referral
  // clicks and 0 referral orders.
  //
  // Thirty lines above, a STALE code is dropped rather than thrown, on the
  // stated grounds that "a stale referral must never hard-block a legitimate
  // sale". A code that is perfectly valid and merely arrived with a small
  // basket has at least as good a claim.
  //
  // So the referral stays attached for ATTRIBUTION — payment-webhook.ts is
  // already built to record a referral_orders row with an ineligible_reason and
  // zero commission for exactly this case — while being inert for PRICING. The
  // invariant that matters is "no undeserved discount", and that is enforced
  // below by referralQualifiesForDiscount, not by refusing the sale.
  //
  // WHAT THIS FLAG IS, AND WHAT IT IS NOT. It answers only "is the basket big
  // enough for the referral to compete", which is what resolveCustomerDiscount
  // needs as an input. It is NOT "the shopper is getting a referral discount":
  // the referral still has to WIN that contest, and it loses to Buy-3-Get-1, to
  // quantity-bundle pricing, to membership, to bulk savings. Store credit and
  // points are exclusive of a referral discount that is actually given, so they
  // gate on the resolved outcome further down (`referralDiscountApplied`), not
  // on this. Using this flag for them charged a shopper her own store-credit
  // balance to buy a discount of $0.00.
  let referralQualifiesForDiscount = false;
  if (referral) {
    const ambassadorSettings = await getAmbassadorProgramSettings();
    referralQualifiesForDiscount = referralQualifies(subtotal, ambassadorSettings.minimumQualifyingOrder);

    const customerEmail = input.customer.email.trim().toLowerCase();
    const isSelfReferralByEmail = Boolean(referral.ambassadorEmail) && referral.ambassadorEmail!.trim().toLowerCase() === customerEmail;
    const isSelfReferralByAccount = Boolean(referral.ambassadorAuthUserId) && Boolean(input.customerUserId) && referral.ambassadorAuthUserId === input.customerUserId;

    if (isSelfReferralByEmail || isSelfReferralByAccount) {
      throw new Error("You can't use your own referral code on your own order.");
    }
  }

  // Coupons master switch.
  if (couponEntered && !couponPolicy.couponsEnabled) {
    throw new Error("Coupons are currently disabled. Remove the coupon code to continue.");
  }
  const coupon = couponPolicy.couponsEnabled && couponEntered
    ? await validateCoupon(input.couponCode, discountBase, input.customer.email, { isActiveMember: memberPerks.isActiveMember })
    : null;

  // WHO GETS FREE SHIPPING — four independent grants, any one of which is
  // enough. Two are account-tied and were always here (a bulk-savings tier, a
  // membership plan that includes it); two are new (a one-time offer whose
  // reward is free shipping, and a coupon flagged to waive it).
  //
  // NONE OF THEM COMPETE. resolveCustomerDiscount below picks a single winner
  // among referral, membership, bulk and coupon — shipping is not in that
  // race. So a code can waive shipping AND lose the percentage race, and the
  // customer still gets the free shipping they were promised, which is what
  // "free shipping + 15% off" means to the person reading it.
  //
  // MOVED DOWN FROM ABOVE THE PROMOTION BLOCK so it can see `coupon`, which is
  // resolved a few lines up. Nothing read `shipping` in between — checked, not
  // assumed — so the value is unchanged for every order that has no coupon.
  //
  // With no address yet (express wallet), shipping is NOT knowable, so it
  // resolves to 0 here and is locked later from the wallet's address callback.
  const shipping = !destinationKnown
    ? 0
    : (bulkSavingsResult.tier || memberPerks.freeShipping || offerGrantsFreeShipping || coupon?.freeShipping)
      ? 0
      : roundMoney(calculateShipping(subtotal, input.customer.country, shippingConfig));

  // Personal ambassador discount: an approved ambassador gets a discount on
  // their OWN purchase. It earns NO commission (self-referral is blocked) and,
  // like every discount here, does not stack unless stacking is enabled.
  const isApprovedAmbassadorSelf = await isApprovedAmbassadorCustomer(input.customerUserId, input.customer.email);
  const personalDiscountAmount = isApprovedAmbassadorSelf && referralProgram.personalDiscountPercent > 0
    ? calculateDiscountAmount(discountBase, referralProgram.personalDiscountPercent)
    : 0;

  // Active-member pricing competes as one of the candidate discounts (greatest
  // savings wins, no stacking) so a member always gets at least their tier
  // discount whenever it's the best available deal.
  const memberPricingAmount = memberPerks.memberDiscountPercent > 0
    ? calculateDiscountAmount(discountBase, memberPerks.memberDiscountPercent)
    : 0;

  // Resolve the customer discount through the SHARED profit-engine rulebook, so
  // checkout, the profit guard, and the client preview can never diverge:
  //  • ONE customer discount (best value) among referral / membership / bulk /
  //    personal / coupon.
  //  • The one intentional stack: a BUNDLE (Buy 3 Get 1) order + a code =
  //    bundle discount PLUS a reduced referral % (admin-set, default 5%).
  //  • Coupons stack only when the admin enables it.
  // Ambassador commission is handled separately below — it is NOT a customer
  // discount and is never removed because another discount applied.
  const customerDiscount = resolveCustomerDiscount(
    {
      subtotal,
      fullSubtotal: discountBase,
      quantityBundleSavings,
      productCost: 0,
      bundleDiscount: promotionDiscount,
      referralAccepted: referralQualifiesForDiscount,
      referralPercent: referralQualifiesForDiscount && referral ? referral.discountPercent : 0,
      isMember: memberPricingAmount > 0,
      membershipPercent: memberPerks.memberDiscountPercent,
      // ONE SLOT, THE BETTER OF THE TWO. A combined gift's percentage and a
      // typed coupon are the same kind of thing — a code-shaped percentage off
      // — so they take the same slot and the customer keeps whichever is worth
      // more. Adding a separate candidate would have meant changing
      // resolveCustomerDiscount, which every other discount in the store also
      // depends on, for no behaviour a customer could tell apart.
      couponDiscount: Math.max(coupon ? coupon.discountAmount : 0, offerPercentDiscount),
      bulkSavingsAmount: bulkSavingsResult.amount,
      personalDiscountAmount,
      personalDiscountPercent: referralProgram.personalDiscountPercent,
      allowCouponStacking: couponPolicy.allowStacking || promotionAllowsCouponStacking,
      commissionPercent: 0,
      processingFeePercent: 0,
      shippingCollected: 0,
      shippingCost: 0,
      handlingCollected: 0,
      taxPercent: 0,
    },
    new Set(["coupon", "referral", "bundle", "membership"]),
  );
  const discountAmount = customerDiscount.amount;
  const bulkDiscountTier = customerDiscount.label === "Bulk savings" ? bulkSavingsResult.tier : null;
  // IS THE SHOPPER ACTUALLY GETTING A REFERRAL DISCOUNT?
  //
  // Read off the resolved winner rather than re-derived, because every
  // re-derivation of this question has so far got it wrong. `components`
  // carries "referral" only when the referral bucket beat every other
  // candidate; it loses whenever a Buy-3-Get-1 bundle is present
  // (`!isBundle && hasReferral`), whenever quantity-bundle pricing already in
  // the subtotal competes it to zero, and whenever membership, bulk savings or
  // an ambassador personal discount is worth more. In each of those the code is
  // real, the basket qualifies, and the discount is exactly $0.00.
  const referralDiscountApplied = customerDiscount.components.includes("referral") && discountAmount > 0;

  // Sales tax — dynamic, from the SHIPPING ADDRESS: collected only for
  // destinations in the admin-configured nexus states, at the destination
  // state's rate (shipping included in the base where that state taxes it).
  // quoteSalesTax runs the same shared resolveSalesTax the checkout preview
  // uses, so the client and server totals agree line for line.
  //
  // With no address yet (express wallet) the country/state are blank, which
  // resolves to a $0, non-collected quote — tax is locked later from the
  // wallet's address callback.
  const taxQuote = await quoteSalesTax({
    taxableAmount: Math.max(0, roundMoney(subtotal - discountAmount)),
    shippingAmount: shipping,
    country: destinationKnown ? input.customer.country : null,
    state: destinationKnown ? input.customer.state : null,
    city: destinationKnown ? input.customer.city : null,
    postalCode: destinationKnown ? input.customer.postalCode : null,
    street: destinationKnown ? input.customer.address : null,
  });
  const taxAmount = taxQuote.amount;

  // PROFIT GUARD — never let this pricing combination complete below the store's
  // configured floor (default: never negative). Uses the shared profit-engine
  // math so checkout and the engine can never disagree. Ambassador commission is
  // a real cost here, but it is NOT a customer discount — it's computed
  // separately on the discounted subtotal. Product cost falls back to the
  // worst-case unit cost until real per-SKU costs are entered.
  const profitSettings = await getProfitSettings();
  // Price the guard with the EFFECTIVE commission that will actually be recorded
  // (an unlocked ambassador on a performance tier earns more than their stored
  // rate). Using the stored rate here let a thin-margin order pass the guard yet
  // finalize below true break-even once the higher tier commission was applied.
  // Only a QUALIFYING referral will accrue commission, so only a qualifying one
  // may be charged for it here. Reserving a phantom commission on a basket that
  // will never earn one tightens the break-even floor for no reason and can
  // refuse the order outright with "Promotion unavailable on this order."
  let guardCommissionPercent = 0;
  if (referral && referralQualifiesForDiscount) {
    try {
      const effective = await getEffectiveCommissionPercent({ ambassadorId: referral.ambassadorId, fallbackPercent: referral.commissionPercent });
      guardCommissionPercent = Math.max(referral.commissionPercent, effective.percent);
    } catch {
      guardCommissionPercent = referral.commissionPercent;
    }
  }
  // Price the floor against REAL per-line cost: the chosen dose's cost if known,
  // else the product's cost, else the conservative worst-case fallback.
  //
  // THE SAME THREE CASES AS resolveUnitCostCents, AND FOR THE SAME REASON. On a
  // slug that HAS dose rows, the parent `products.product_cost_cents` is a stale
  // inherited EvoLabs figure, not a cost for the dose actually being bought, so
  // it is refused here exactly as the snapshot resolver refuses it. This guard
  // used to substitute it, and the substitution does not merely "tighten the
  // floor": where the stale parent sits BELOW worstCaseUnitCost it understates
  // COGS, overstates profit, and lets a deep discount through the floor that the
  // worst-case assumption would have stopped.
  const guardProductCost = roundMoney(lineItems.reduce((sum, line) => {
    const slug = String(line.product.id).split("::")[0];
    const doseCost = line.product.variantId ? unitCostByDoseId.get(line.product.variantId) : undefined;
    const unitCost = (doseCost && doseCost > 0)
      ? doseCost
      : (slugsWithDoses.has(slug)
        ? profitSettings.worstCaseUnitCost
        : (unitCostBySlug.get(slug) ?? profitSettings.worstCaseUnitCost));
    return sum + unitCost * line.quantity;
  }, 0));
  const guardProfit = computeProfit(
    {
      subtotal,
      productCost: guardProductCost,
      bundleDiscount: 0,
      referralAccepted: referralQualifiesForDiscount,
      referralPercent: 0,
      isMember: false,
      membershipPercent: 0,
      couponDiscount: 0,
      allowCouponStacking: false,
      commissionPercent: guardCommissionPercent,
      processingFeePercent: profitSettings.processingFeePercent,
      processingFeeIncludesTax: profitSettings.processingFeeIncludesTax,
      shippingCollected: shipping,
      // Charge the guard for what the store actually pays to ship this order
      // (admin-configurable, same figure used in profit reports). Previously 0,
      // which let a free-shipping / thin-margin order pass the break-even floor
      // yet finalize at a real cash loss equal to the shipping cost.
      //
      // EXCEPT with no address. In "address_optional" mode `shipping` above is
      // 0 by construction — the destination is unknown, so the fee the shopper
      // will pay is not knowable yet. Charging the shipping COST against
      // revenue that excludes the shipping FEE compares two different orders
      // and makes every thin-margin cart look like a loss: GHRP-2 at $39.99
      // against a $33 cost cleared the card lane by $11.59 and was refused by
      // the wallet lane at -$2.21, so the Apple Pay button silently vanished on
      // an order the store was happy to take. Credit neither or charge both.
      //
      // Nothing is let through by this: express/authorize re-quotes in "full"
      // mode with the real address, and THAT is the authoritative guard. An
      // order that genuinely loses money on goods alone still fails here.
      shippingCost: destinationKnown ? profitSettings.shippingCostPerOrder : 0,
      handlingCollected: 0,
      // Effective rate actually applied to this destination (0 when the
      // order ships to a non-nexus state). Tax stays pass-through in the
      // engine; the rate only feeds the processing-fee-on-total model.
      taxPercent: taxQuote.ratePercent,
    },
    { amount: discountAmount, components: [], label: "resolved" },
  );
  if (!meetsFloor(guardProfit, profitSettings)) {
    throw new Error("Promotion unavailable on this order.");
  }

  const totalBeforePoints = roundMoney(subtotal + shipping + taxAmount - discountAmount);

  // Membership store credit auto-applies when the order's merchandise subtotal
  // meets the tier's redemption minimum (the margin guardrail). It's deducted
  // before points; the actual ledger deduction is recorded once the order is
  // paid (payment-webhook), and returned if the order is later refunded.
  // A REFERRAL THAT GIVES NOTHING IS NOT A DISCOUNT TO BE EXCLUSIVE OF.
  //
  // The rule is that store credit and points never stack with a referral
  // DISCOUNT, and it is unchanged. What changed is the test for it. This read
  // `!referral` — "a code is attached" — and while quoteOrder threw on a
  // below-minimum referral that was close enough, because the inert case could
  // not reach this line. Removing the throw made it reachable, the client and
  // server stopped agreeing, and the shopper watched $50 of her own credit come
  // off the displayed total before create-session refused the order and told
  // her to refresh a page that recomputes the same number.
  //
  // The first repair swapped it for `!referralQualifiesForDiscount`, which is
  // BASKET SIZE and only half the question. A $263.95 basket of five vials
  // clears the $100 minimum, so the flag said yes — but quantity-bundle pricing
  // had already granted $36.00 and competed the ambassador's $30.00 down to
  // exactly $0.00. The shopper was charged $50 more than the same cart without
  // the link, for a discount of nothing, on both the card and the express lane,
  // with the two sides agreeing so nothing surfaced.
  //
  // `referralDiscountApplied` is the resolved outcome, so the rule now says
  // what it always meant.
  const storeCreditRedeemedCents = resolveStoreCreditCents({
    referralDiscountApplied,
    balanceCents: memberPerks.storeCreditBalanceCents,
    minOrderCents: memberPerks.storeCreditMinOrderCents,
    subtotalCents: Math.round(subtotal * 100),
    redeemableCents: Math.round(totalBeforePoints * 100),
  });
  const storeCreditDiscount = roundMoney(storeCreditRedeemedCents / 100);
  const totalAfterCredit = roundMoney(Math.max(0, totalBeforePoints - storeCreditDiscount));

  // Points redemption stacks with a coupon or Buy 3 Get 1 Free (it behaves
  // like store credit, not a promo code) but never with a referral DISCOUNT -
  // and redemption is silently zeroed rather than erroring, because points
  // aren't something a shopper deliberately "combines"; the balance is just
  // sitting on their account. Capped to the balance still owed and to the
  // customer's actual point balance.
  //
  // Same predicate as store credit directly above, and for the same reason.
  let pointsRedeemed = 0;
  let pointsDiscountAmount = 0;
  if (input.customerUserId && input.pointsToRedeem && input.pointsToRedeem > 0) {
    const balance = await getPointsBalance(input.customerUserId);
    const requestedPoints = Math.min(Math.floor(input.pointsToRedeem), balance);
    pointsDiscountAmount = roundMoney(resolvePointsRedemptionCents({
      referralDiscountApplied,
      requestedCents: Math.round(pointsToDollars(requestedPoints) * 100),
      redeemableCents: Math.round(totalAfterCredit * 100),
    }) / 100);
    pointsRedeemed = dollarsToPoints(pointsDiscountAmount);
  }

  // Optional shipping-protection add-on: server recomputes the tiered fee from
  // the server-side subtotal (never trusts a client amount) and adds it on top,
  // mirroring the client preview so the totals match the anti-tamper guard.
  const shippingProtectionFee = input.shippingProtection ? calculateShippingProtectionFee(subtotal) : 0;
  const expectedTotal = roundMoney(Math.max(0, totalAfterCredit - pointsDiscountAmount) + shippingProtectionFee);

  // The guard only blocks UNDERpayment (a client trying to pay less than the
  // real total). Membership perks are applied authoritatively on the server
  // and only ever LOWER the total, so a client total >= the server total is
  // always safe and accepted (the customer is charged the correct perked total).
  if (
    input.expectedTotal !== undefined &&
    Number(input.expectedTotal) < expectedTotal - 0.01
  ) {
    throw new Error("Altered total detected");
  }

  // Resolve the chosen payment method and, for card orders only, add the
  // configurable card processing fee on top of expectedTotal. Manual methods
  // carry no fee. Both the fee config and the method list come from the server
  // so the client can never spoof a lower fee - the client only previews the
  // same shared calculation.
  const [paymentMethods, cardFeeConfig] = await Promise.all([
    getPaymentMethodsConfig(),
    getCardProcessingFeeConfig(),
  ]);
  const selectedMethodId = input.paymentMethod?.trim() || "card";
  const selectedMethod = getPaymentMethodById(paymentMethods, selectedMethodId);

  if (!selectedMethod || !selectedMethod.enabled) {
    throw new Error("Unavailable payment method");
  }

  const isManual = isManualPaymentMethod(selectedMethod);
  const cardFee = isManual
    ? { amount: 0, percentage: 0 }
    : calculateCardProcessingFee(expectedTotal, cardFeeConfig);
  const finalTotal = roundMoney(expectedTotal + cardFee.amount);

  // Snapshot the CURRENT internal cost (COGS) onto each line so profit for this
  // order is always computed with the cost that applied today — a later cost
  // change never rewrites this order's profit. Prefer the dose's cost, else the
  // product's. If NEITHER is set we snapshot null (unknown) rather than the
  // guard's worst-case assumption, so profit reports show real cost when known
  // and flag an estimate when not — never presenting an assumption as fact.
  const unitCostCentsForLine = (line: QuoteOrderLine): number | null =>
    resolveUnitCostCents(
      String(line.product.id).split("::")[0],
      line.product.variantId,
      unitCostByDoseId,
      unitCostBySlug,
      slugsWithDoses,
    );

  // The labelled breakdown a wallet sheet renders VERBATIM. Built here, on the
  // server, from the same numbers the charge is made of — a wallet client must
  // never derive a money row of its own. Shipping and sales tax are deliberately
  // absent: they are appended by the wallet's address callback, from the
  // amount authority's response, once a destination exists.
  const displayLineItems: QuoteDisplayLineItem[] = [
    { label: "Subtotal", amountCents: Math.round(subtotal * 100) },
  ];
  if (discountAmount > 0) {
    displayLineItems.push({
      label: customerDiscount.label || "Discount",
      amountCents: -Math.round(discountAmount * 100),
    });
  }
  if (storeCreditRedeemedCents > 0) {
    displayLineItems.push({ label: "Store credit", amountCents: -storeCreditRedeemedCents });
  }
  if (pointsDiscountAmount > 0) {
    displayLineItems.push({ label: "Rewards points", amountCents: -Math.round(pointsDiscountAmount * 100) });
  }
  // Shipping protection is an OPT-IN paid add-on, off by default and never
  // pre-selected (see shipping-protection.ts:12-19). It gets its own labelled
  // row so a one-tap shopper sees what they are paying for at the moment of
  // authorization, not only in the drawer they may have scrolled past.
  if (shippingProtectionFee > 0) {
    displayLineItems.push({ label: "Shipping Protection", amountCents: Math.round(shippingProtectionFee * 100) });
  }
  // Same reasoning for the card service fee: it is charged on this lane exactly
  // as it is on the card form (price parity), so it must be disclosed as its own
  // row rather than folded silently into "Subtotal".
  if (cardFee.amount > 0) {
    displayLineItems.push({ label: cardFeeConfig.label || "Service Fee", amountCents: Math.round(cardFee.amount * 100) });
  }

  return {
    lineItems,
    subtotal,
    shipping,
    discountAmount,
    bulkDiscountTier,
    isPriorityOrder,
    taxQuote,
    taxAmount,
    referral,
    couponCode: coupon?.code ?? null,
    isBuy3Get1Active,
    appliedOffer,
    appliedPromotionId,
    appliedPromotionName,
    appliedPromotionLimits,
    storeCreditRedeemedCents,
    pointsRedeemed,
    pointsDiscountAmount,
    shippingProtectionFee,
    expectedTotal,
    paymentMethods,
    selectedMethod,
    isManualPayment: isManual,
    cardFee,
    finalTotal,
    unitCostCentsForLine,
    addressIndependentCents: Math.round(finalTotal * 100),
    displayLineItems,
  };
}

// -------------------------------------------------------------------------
// Order row writing — also lifted verbatim, so the express lane writes a row
// that is indistinguishable from a card-checkout row (same columns, same
// pre-migration degradation retries) instead of a near-copy that drifts.
// -------------------------------------------------------------------------

export interface OrderRowInput {
  orderId: string;
  orderNumber: string;
  idempotencyKey: string | null;
  paymentId: string | null;
  paymentMethod: string;
  cardProcessingFee: number;
  cardProcessingFeePercent: number;
  customer: CustomerInput;
  billing?: {
    fullName?: string;
    address?: string;
    city?: string;
    postalCode?: string;
  };
  currency: string;
  subtotal: number;
  shippingAmount: number;
  taxAmount: number;
  discountAmount: number;
  /**
   * The Shipping Protection add-on, in dollars. Part of amountPaid.
   *
   * It has to be passed in rather than recomputed here from `subtotal`: the fee
   * is only charged when the shopper leaves the box ticked, and this function
   * has no way to know whether they did. Recomputing would silently charge
   * every order for protection in the books that did not pay for it.
   */
  shippingProtectionFee: number;
  bulkDiscountTier: string | null;
  priority: boolean;
  amountPaid: number;
  referralCode: string | null;
  ambassadorId: string | null;
  couponCode: string | null;
  customerUserId: string | null;
  pointsRedeemed: number;
  storeCreditRedeemedCents: number;
  taxRatePercent: number;
  taxState: string | null;
  /** Buy X Get Y promotion that priced the order, if any. */
  promotionId?: string | null;
  /** Extra columns (e.g. checkout_channel) that live on the newer-column row. */
  extraColumns?: Record<string, unknown>;
}

export interface OrderRowDraft {
  /** Every column, including the ones added by later migrations. */
  full: Record<string, unknown>;
  /** The original column set — the pre-migration fallback. */
  base: Record<string, unknown>;
}

export function buildOrderRow(input: OrderRowInput): OrderRowDraft {
  const baseOrderRow: Record<string, unknown> = {
    order_id: input.orderId,
    order_number: input.orderNumber,
    idempotency_key: input.idempotencyKey,
    payment_id: input.paymentId,
    payment_method: input.paymentMethod,
    card_processing_fee: input.cardProcessingFee,
    card_processing_fee_percent: input.cardProcessingFee > 0 ? input.cardProcessingFeePercent : 0,
    customer_email: input.customer.email,
    customer_name: input.customer.fullName,
    shipping_address: input.customer.address,
    // Stored separately rather than concatenated into the street line: Shippo
    // wants street2 as its own field, and a joined "123 Main St, Apt 4B" is not
    // reliably splittable back out afterwards.
    shipping_address_2: input.customer.address2?.trim() || null,
    city: input.customer.city,
    postal_code: input.customer.postalCode,
    country: input.customer.country,
    currency: input.currency,
    subtotal: input.subtotal,
    shipping_amount: input.shippingAmount,
    handling_fee: 0,
    tax_amount: input.taxAmount,
    discount_amount: input.discountAmount,
    bulk_discount_tier: input.bulkDiscountTier,
    bulk_discount_amount: input.bulkDiscountTier ? input.discountAmount : 0,
    priority: input.priority,
    amount_paid: input.amountPaid,
    referral_code: input.referralCode,
    ambassador_id: input.ambassadorId,
    coupon_code: input.couponCode,
    customer_user_id: input.customerUserId,
    points_redeemed: input.pointsRedeemed,
    store_credit_redeemed_cents: input.storeCreditRedeemedCents,
    payment_status: "pending_payment",
    fulfillment_status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // state/phone (orders-state-phone.sql) and the tax recordkeeping fields
  // (dynamic-sales-tax.sql) are newer columns. Try to store them, but if a
  // migration hasn't been applied yet, fall back to inserting without them so
  // checkout NEVER breaks over a missing column. tax_amount itself is an
  // original column and always stored (in baseOrderRow above).
  const billing = input.billing;
  const orderRowWithContact: Record<string, unknown> = {
    ...baseOrderRow,
    state: input.customer.state ?? null,
    phone: input.customer.phone ?? null,
    billing_full_name: billing?.fullName ? sanitizeText(billing.fullName) : null,
    billing_address: billing?.address ? sanitizeText(billing.address) : null,
    billing_city: billing?.city ? sanitizeText(billing.city) : null,
    billing_postal_code: billing?.postalCode ? sanitizeText(billing.postalCode) : null,
    // Exact tax audit trail: the rate applied and the destination state it
    // was applied for (null when no tax was collected), so the admin tax
    // report can group collections by state without re-deriving rates.
    tax_rate_percent: input.taxRatePercent,
    tax_state: input.taxState,
    // Charged, and now recorded. It was folded into amount_paid and stored
    // nowhere, so an order could not reproduce its own total and reconciliation
    // had to tolerate an unexplained overage up to the maximum possible fee —
    // a band too wide to tell a protection fee from a real overcharge.
    shipping_protection_fee: input.shippingProtectionFee,
    // Which promotion priced this order. On the FULL row only, so a database
    // that has not yet run bxgy-promotions.sql still takes the order through
    // the base-row fallback below — a missing migration must never cost a sale.
    // Usage limits are counted from this column, so an order that is later
    // refunded or cancelled releases its redemption without anything having to
    // remember to decrement a counter.
    promotion_id: input.promotionId ?? null,
    ...(input.extraColumns ?? {}),
  };

  const baseWithoutIdempotency = { ...baseOrderRow };
  delete baseWithoutIdempotency.idempotency_key;

  return { full: orderRowWithContact, base: baseWithoutIdempotency };
}

export type OrderInsertOutcome =
  | { status: "inserted" }
  /** A unique-index violation — a concurrent submit with the same key won. */
  | { status: "duplicate" }
  | { status: "error"; error: { code?: string; message?: string } };

/**
 * Columns whose absence changes what an order MEANS, rather than merely how
 * completely it is described.
 *
 * `idempotency_key` is the duplicate-charge guard: without it the 23505 check
 * cannot fire on this key, and the one protection against writing the same order
 * twice is gone. The two tax columns are what `admin-tax-report` reads, and it
 * never re-derives rates — an order missing them is silently wrong in the one
 * report with a legal consequence.
 *
 * Losing one of these is still allowed when the column genuinely does not exist
 * (refusing every checkout on a deployment that predates a migration would be
 * worse), but it is never allowed to be SILENT.
 */
const ORDER_INTEGRITY_COLUMNS = new Set(["idempotency_key", "tax_state", "tax_rate_percent"]);

/** A backstop only. The `column in row` check below is what actually terminates. */
const MAX_COLUMN_PEELS = 8;

/**
 * The column name from a missing-column error, or null if this is not one.
 *
 * Two shapes reach us:
 *   PostgREST: Could not find the 'checkout_channel' column of 'orders' in the schema cache
 *   Postgres:  column "checkout_channel" of relation "orders" does not exist
 *
 * PGRST204 in particular is a STALE SCHEMA CACHE, which is an ordinary event in
 * the minutes after a migration is applied — not a rare disaster.
 */
function missingColumnFrom(error: { code?: string; message?: string } | null): string | null {
  if (!error) return null;
  const message = String(error.message ?? "");
  const code = String(error.code ?? "");
  const looksMissing =
    code === "PGRST204"
    || code === "42703"
    || /schema cache|does not exist|could not find|unknown column/i.test(message);
  if (!looksMissing) return null;

  const quoted = message.match(/'([A-Za-z0-9_]+)'/) ?? message.match(/"([A-Za-z0-9_]+)"/);
  return quoted?.[1] ?? null;
}

/**
 * Insert the order, degrading around a column the database does not have.
 *
 * WHY THIS IS NOT A FALLBACK TO A FIXED ROW ANY MORE.
 *
 * It used to retry with `draft.base` — a frozen pre-migration column set — as
 * soon as anything looked like a missing column. So a PGRST204 about ONE column
 * dropped ALL of `idempotency_key`, `tax_state`, `tax_rate_percent`,
 * `shipping_protection_fee`, `state`, `phone` and `billing_*` in a single step.
 * A stale schema cache on an unrelated column could take an order with its
 * duplicate-charge guard removed, and nothing errored and nothing alerted.
 *
 * Now it removes only the column the database actually named, and tries again —
 * so a deployment several migrations behind peels off exactly what is missing and
 * keeps everything else. Dropping an integrity column is still permitted, because
 * refusing the sale would be worse, but it raises a critical alert so it is never
 * silent.
 *
 * `draft.base` is retained on the type for compatibility and is deliberately no
 * longer used: degrading to a fixed row is the defect this replaced.
 *
 * Returns "duplicate" rather than resolving the winning row itself, because what
 * a caller should DO about a duplicate differs by lane.
 */
export async function insertOrderRow(draft: OrderRowDraft): Promise<OrderInsertOutcome> {
  const row: Record<string, unknown> = { ...draft.full };
  const dropped: string[] = [];
  let lastError: { code?: string; message?: string } | null = null;

  for (let attempt = 0; attempt <= MAX_COLUMN_PEELS; attempt += 1) {
    const { error } = await supabaseAdmin.from("orders").insert(row);

    if (!error) {
      const lostIntegrityColumns = dropped.filter((column) => ORDER_INTEGRITY_COLUMNS.has(column));
      if (lostIntegrityColumns.length > 0) {
        // The order was taken. Somebody has to know it was taken without its
        // guard, because nothing downstream can tell.
        await recordSystemAlert({
          type: "order_integrity_column_missing",
          severity: "critical",
          message:
            `Order ${String(draft.full.order_number ?? draft.full.order_id ?? "")} was written without `
            + `${lostIntegrityColumns.join(", ")} because the database does not have `
            + "that column. Apply the outstanding migration: until then these orders have no "
            + "duplicate-charge protection and/or no sales-tax audit trail.",
          context: {
            orderId: draft.full.order_id ?? null,
            orderNumber: draft.full.order_number ?? null,
            droppedColumns: dropped,
            integrityColumnsLost: lostIntegrityColumns,
          },
        }).catch((alertError) => {
          // Never let a failed alert undo a completed order.
          console.error("Unable to record an order-integrity alert", alertError);
        });
      }
      return { status: "inserted" };
    }

    lastError = error as { code?: string; message?: string };
    if (String((error as { code?: string }).code ?? "") === "23505") {
      return { status: "duplicate" };
    }

    const column = missingColumnFrom(error as { code?: string; message?: string });
    // Only peel a column this row actually carries. If the error names something
    // we never sent — or is not a missing-column error at all — degrading further
    // cannot help and would only write a thinner, wronger order.
    if (!column || !(column in row)) {
      return { status: "error", error };
    }

    delete row[column];
    dropped.push(column);
  }

  // Only reachable if the database named a new missing column on every attempt
  // up to the backstop. lastError is always set by then.
  return {
    status: "error",
    error: lastError ?? { code: "column_peel_exhausted", message: "Too many missing columns to insert this order." },
  };
}

// The order_items rows for a quote, with the same pre-migration degradation
// (unit_cost_cents arrived with product-cost-tracking.sql).
export async function insertOrderItems(
  orderId: string,
  lineItems: QuoteOrderLine[],
  unitCostCentsForLine: (line: QuoteOrderLine) => number | null,
): Promise<{ payload: Array<{ product_id: string; quantity: number }>; error: unknown }> {
  const orderItemsPayload = lineItems.map((line) => ({
    order_id: orderId,
    product_id: line.product.id,
    product_name: line.product.variantLabel ? `${line.product.name} (${line.product.variantLabel})` : line.product.name,
    unit_price: line.product.price,
    quantity: line.quantity,
    line_total: roundMoney(line.product.price * line.quantity),
    unit_cost_cents: unitCostCentsForLine(line),
  }));

  let { error: itemInsertError } = await supabaseAdmin.from("order_items").insert(orderItemsPayload);
  // Backwards-compatible: if the cost-snapshot migration hasn't been run yet the
  // unit_cost_cents column won't exist. Never let that break checkout — retry
  // the insert without the snapshot column.
  if (itemInsertError && (itemInsertError.code === "PGRST204" || /unit_cost_cents/i.test(itemInsertError.message ?? ""))) {
    const legacyPayload = orderItemsPayload.map((item) => ({
      order_id: item.order_id,
      product_id: item.product_id,
      product_name: item.product_name,
      unit_price: item.unit_price,
      quantity: item.quantity,
      line_total: item.line_total,
    }));
    ({ error: itemInsertError } = await supabaseAdmin.from("order_items").insert(legacyPayload));
  }

  return { payload: orderItemsPayload, error: itemInsertError };
}
