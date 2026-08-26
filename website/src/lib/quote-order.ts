// No `server-only` directive here, matching payment-service.ts (this file is a
// straight lift out of it): the unit tests import the checkout path directly,
// and the transitive supabase-server import already makes a client import a
// build error.
import { getCatalogProductsBySlugs, getStockLevelsBySlugs } from "@/lib/catalog";
import { calculateDiscountAmount } from "@/lib/referral-service";
import { resolveAmbassadorCustomerDiscount } from "@/lib/ambassador-discount";
import { referralQualifies } from "@/lib/referral-qualification";
import { validateCoupon } from "@/lib/coupons";
import { getMembershipPerks, getPointsBalance, isEligibleForBulkSavings, isPriorityMember } from "@/lib/membership";
import { dollarsToPoints, pointsToDollars } from "@/lib/points-math";
import { getAmbassadorProgramSettings } from "@/lib/ambassador-settings";
import { getEffectiveCommissionPercent } from "@/lib/ambassador-commission";
import { getBundleDiscountedUnitPrice } from "@/lib/bundle-pricing";
import { calculateShipping, isDomesticCountry, isShippableCountry } from "@/lib/shipping";
import { normalizeUsState } from "@/lib/sales-tax";
import { recordSystemAlert } from "@/lib/monitoring";
import { quoteSalesTax, type ResolvedOrderTax } from "@/lib/tax-provider";
import { calculateShippingProtectionFee } from "@/lib/shipping-protection";
import { isApprovedAmbassadorCustomer } from "@/lib/ambassador-status";
import { calculateBulkSavingsDiscount } from "@/lib/bulk-savings";
import { getHomepageControlConfig, getBulkSavingsControlConfig, getPaymentMethodsConfig, getCardProcessingFeeConfig, getShippingConfig, getReferralProgramConfig, getCouponPolicyConfig, getProfitSettings } from "@/lib/admin-control";
import { computeProfit, resolveCustomerDiscount } from "@/lib/profit-engine";
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

export type QuoteMode = "full" | "address_optional" | "destination_only";

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
   * "full" (card checkout / express authorize): the whole contact is known and
   * validated, shipping + tax are priced.
   * "address_optional" (express session create): no address yet, shipping + tax
   * are 0 and `addressIndependentCents` carries the wallet sheet's opening
   * amount.
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

// Every 4th item (cheapest-first) is free. The caller gates this behind
// getHomepageControlConfig().promoBuy3Get1Enabled - mirrors the client-side
// calculation in cart-context.tsx exactly (including that same gate, fetched
// there via /api/catalog/promotions) so the server total this function feeds
// into always matches what the cart displayed - see the "Altered total
// detected" check in payment-service.ts.
function calculateBuy3Get1Discount(lineItems: Array<{ product: ServerProduct; quantity: number }>) {
  const expandedPrices: number[] = [];
  for (const line of lineItems) {
    for (let i = 0; i < line.quantity; i += 1) {
      expandedPrices.push(line.product.price);
    }
  }

  const freeItemCount = Math.floor(expandedPrices.length / 4);
  if (freeItemCount <= 0) {
    return 0;
  }

  expandedPrices.sort((a, b) => a - b);
  return roundMoney(expandedPrices.slice(0, freeItemCount).reduce((sum, price) => sum + price, 0));
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

export async function quoteOrder(input: QuoteOrderInput): Promise<QuoteResult> {
  // Whether a destination is known well enough to price shipping and tax.
  const destinationKnown = input.mode !== "address_optional";

  if (input.mode === "full") {
    validateCustomer(input.customer);
  } else if (input.mode === "destination_only") {
    validateDestination(input.customer);
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

  const requestedSlugs = Array.from(new Set(sanitizedItems.map((item) => item.id.split("::")[0])));
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
  for (const row of (costRows ?? []) as Array<{ slug: string; product_cost_cents: number | null; product_doses: Array<{ id: string; product_cost_cents: number | null }> | null }>) {
    const productCostCents = Number(row.product_cost_cents ?? 0);
    if (productCostCents > 0) unitCostBySlug.set(String(row.slug), productCostCents / 100);
    for (const dose of row.product_doses ?? []) {
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

  const [{ promoBuy3Get1Enabled }, bulkSavingsConfig, bulkSavingsEligible, isPriorityOrder, shippingConfig, memberPerks, referralProgram, couponPolicy] = await Promise.all([
    Promise.resolve(homepageControlConfig),
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
  // Free shipping is a perk of reaching the bulk-savings threshold OR of an
  // active membership tier whose plan includes free shipping. Both are
  // account-tied and evaluated server-side.
  //
  // With no address yet (express wallet), shipping is NOT knowable, so it
  // resolves to 0 here and is locked later from the wallet's address callback.
  const shipping = !destinationKnown
    ? 0
    : (bulkSavingsResult.tier || memberPerks.freeShipping)
      ? 0
      : roundMoney(calculateShipping(subtotal, input.customer.country, shippingConfig));
  // With bundle stacking off, the Buy-3-Get-1 free item is valued at FULL
  // price and competes with the bundle savings like every other candidate.
  const buy3Get1Discount = promoBuy3Get1Enabled
    ? calculateBuy3Get1Discount(bundleStacking
      ? lineItems
      : lineItems.map((line) => ({ product: { ...line.product, price: line.baseUnitPrice }, quantity: line.quantity })))
    : 0;
  const isBuy3Get1Active = buy3Get1Discount > 0;

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
    if (isBuy3Get1Active && couponEntered) {
      throw new Error("Coupon codes cannot be combined with Buy 3 Get 1 Free. Remove the coupon code to continue.");
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
  // Exclusivity is deliberately NOT relaxed here: store credit and points stay
  // suppressed whenever a code is attached, qualifying or not, because the cart
  // preview suppresses them on exactly the same condition. Loosening one side
  // alone would let the server silently spend a shopper's store credit on a
  // total the cart never showed them.
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
      bundleDiscount: buy3Get1Discount,
      referralAccepted: referralQualifiesForDiscount,
      referralPercent: referralQualifiesForDiscount && referral ? referral.discountPercent : 0,
      isMember: memberPricingAmount > 0,
      membershipPercent: memberPerks.memberDiscountPercent,
      couponDiscount: coupon ? coupon.discountAmount : 0,
      bulkSavingsAmount: bulkSavingsResult.amount,
      personalDiscountAmount,
      personalDiscountPercent: referralProgram.personalDiscountPercent,
      allowCouponStacking: couponPolicy.allowStacking,
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
  // else the product's cost, else the conservative worst-case fallback. This can
  // only tighten the floor for high-cost SKUs; a missing cost never sells below
  // the old worst-case assumption.
  const guardProductCost = roundMoney(lineItems.reduce((sum, line) => {
    const slug = String(line.product.id).split("::")[0];
    const doseCost = line.product.variantId ? unitCostByDoseId.get(line.product.variantId) : undefined;
    const unitCost = (doseCost && doseCost > 0)
      ? doseCost
      : (unitCostBySlug.get(slug) ?? profitSettings.worstCaseUnitCost);
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
  if (
    guardProfit.grossProfit < profitSettings.minProfitDollars
    || (guardProfit.discountedSubtotal > 0 && guardProfit.grossMarginPercent < profitSettings.minProfitPercent)
  ) {
    throw new Error("Promotion unavailable on this order.");
  }

  const totalBeforePoints = roundMoney(subtotal + shipping + taxAmount - discountAmount);

  // Membership store credit auto-applies when the order's merchandise subtotal
  // meets the tier's redemption minimum (the margin guardrail). It's deducted
  // before points; the actual ledger deduction is recorded once the order is
  // paid (payment-webhook), and returned if the order is later refunded.
  let storeCreditRedeemedCents = 0;
  // Store credit, like points, never stacks with a referral DISCOUNT — referral
  // discounts are exclusive of everything else.
  //
  // A REFERRAL THAT GIVES NOTHING IS NOT A DISCOUNT TO BE EXCLUSIVE OF.
  //
  // This read `!referral`, and while quoteOrder threw on a below-minimum
  // referral that was the same thing: the inert case could not reach this line.
  // Removing the throw made it reachable, and the two sides stopped agreeing —
  // cart-context and the checkout panel suppress on `referralMeetsMinimum`
  // (the basket actually earning the discount) while this still suppressed on
  // "a code is attached". The shopper watched $50 of her own credit come off
  // the displayed total and then had `create-session` refuse the order: her
  // expectedTotal is below the server's, which is precisely what the
  // underpayment guard exists to reject. The refusal even tells her to refresh
  // the page, and refreshing changes nothing.
  //
  // Gating both sides on the discount actually being GIVEN says what the rule
  // always meant, keeps the two in step, and stops an inert code costing a
  // shopper money it never earned her.
  if (!referralQualifiesForDiscount && memberPerks.storeCreditBalanceCents > 0 && Math.round(subtotal * 100) >= memberPerks.storeCreditMinOrderCents) {
    storeCreditRedeemedCents = Math.max(0, Math.min(memberPerks.storeCreditBalanceCents, Math.round(totalBeforePoints * 100)));
  }
  const storeCreditDiscount = roundMoney(storeCreditRedeemedCents / 100);
  const totalAfterCredit = roundMoney(Math.max(0, totalBeforePoints - storeCreditDiscount));

  // Points redemption stacks with a coupon or Buy 3 Get 1 Free (it behaves
  // like store credit, not a promo code) but never with a referral code -
  // referral codes are exclusive of every other discount, so redemption is
  // silently zeroed rather than erroring (points aren't something a shopper
  // deliberately "combines"; the balance is just sitting on their account).
  // Also capped to the remaining balance due and the customer's actual point
  // balance.
  let pointsRedeemed = 0;
  let pointsDiscountAmount = 0;
  // Same rule, same reason as store credit directly above: exclusive of a
  // referral discount that is actually being given, not of a code that is
  // merely attached.
  if (!referralQualifiesForDiscount && input.customerUserId && input.pointsToRedeem && input.pointsToRedeem > 0) {
    const balance = await getPointsBalance(input.customerUserId);
    const requestedPoints = Math.min(Math.floor(input.pointsToRedeem), balance);
    const requestedDollars = pointsToDollars(requestedPoints);
    pointsDiscountAmount = roundMoney(Math.min(requestedDollars, totalAfterCredit));
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
  const unitCostCentsForLine = (line: QuoteOrderLine): number | null => {
    const slug = String(line.product.id).split("::")[0];
    const doseCost = line.product.variantId ? unitCostByDoseId.get(line.product.variantId) : undefined;
    if (doseCost && doseCost > 0) return Math.round(doseCost * 100);
    const slugCost = unitCostBySlug.get(slug);
    if (slugCost && slugCost > 0) return Math.round(slugCost * 100);
    return null;
  };

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
  // Shipping protection is an OPT-IN paid add-on that defaults on. It gets its
  // own labelled row so a one-tap shopper sees what they are paying for at the
  // moment of authorization, not only in the drawer they may have scrolled past.
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
