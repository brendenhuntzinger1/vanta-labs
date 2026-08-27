"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Product } from "@/lib/catalog-types";
import type { ReferralCode } from "@/lib/referral-codes";
import { calculateEarnedPoints, pointsToDollars } from "@/lib/points-math";
import { DEFAULT_MINIMUM_QUALIFYING_ORDER } from "@/lib/referral-config";
import { getBundleDiscountedLineTotal, getBundleDiscountedUnitPrice, DEFAULT_BUNDLE_CONFIG, type BundleConfig } from "@/lib/bundle-pricing";
import { calculateShippingProtectionFee } from "@/lib/shipping-protection";
import { calculateShipping, DEFAULT_SHIPPING_CONFIG, type ShippingConfig } from "@/lib/shipping";
import { DEFAULT_SALES_TAX_CONFIG, type SalesTaxConfig } from "@/lib/sales-tax";
import type { MembershipTierSummary } from "@/lib/member-pricing";
import { calculateBulkSavingsDiscount, getBulkSavingsProgress, DEFAULT_BULK_SAVINGS_CONFIG, type BulkSavingsConfig } from "@/lib/bulk-savings";
import { describeCouponOutcome, resolveCartDiscount, type CouponOutcome, type PriceControllingDiscount } from "@/lib/discount-resolution";
import { resolveAmbassadorCustomerDiscount } from "@/lib/ambassador-discount";
import { referralAppliedMessage, referralCartStatus, referralQualifies, referralShortfall } from "@/lib/referral-qualification";
import { REFERRAL_PROGRAM_PAUSED_MESSAGE, referralProgramAllowsCodes, referralProgramIsOff } from "@/lib/referral-program-gate";
import { resolvePointsRedemptionCents, resolveStoreCreditCents } from "@/lib/store-credit-redemption";

/**
 * THE SUPABASE BROWSER CLIENT IS LOADED ONLY WHEN A CODE ACTUALLY NEEDS CHECKING.
 *
 * referral-client.ts imports @supabase/supabase-js, and this provider is
 * mounted in the root layout -- so a static import put the whole client,
 * GoTrue auth and realtime-js included, into the bundle every page shares.
 * Measured against production: 231 KB of JavaScript to parse (61 KB over the
 * wire), downloaded by every visitor to every page, 18% of all the script on
 * the homepage.
 *
 * Almost nobody needs it. Both call sites are conditional -- one runs only when
 * a referral code is already held, the other only when a shopper types one in.
 * A dynamic import keeps the module out of the shared bundle and fetches it at
 * the moment of use.
 *
 * NOTHING ABOUT THE VALIDATION CHANGES. Same function, same RPC, same server
 * rules; quote-order.ts still re-resolves the rate and owns the charge. This is
 * purely about when the code arrives.
 */
async function validateReferralCodeClient(code: string) {
  const { validateReferralCodeClient: validate } = await import("@/lib/referral-client");
  return validate(code);
}


type CouponDetails = {
  code: string;
  discountType: "percent" | "fixed";
  discountValue: number;
};

export type CartItem = {
  key: string;
  variantId?: string;
  doseLabel?: string;
  sku?: string;
  slug: string;
  name: string;
  price: number;
  quantity: number;
  batchNumber: string;
  image: string;
  stockStatus: string;
  /**
   * Snapshot of the product's requires_reconstitution flag, taken when the
   * line was added. Product metadata only.
   *
   * It does NOT control the BAC Water cross-sell: that offer is shown for
   * every published product whatever form it ships in, because the catalogue
   * holds no formulation data to classify from and a hand-maintained flag
   * would be silently wrong the first time someone forgot to set it.
   */
  requiresReconstitution?: boolean;
};

type CartContextValue = {
  items: CartItem[];
  isCartOpen: boolean;
  isHydrated: boolean;
  referralCode: string | null;
  referralDetails: ReferralCode | null;
  referralError: string | null;
  referralSuccess: string | null;
  /** The programme's minimum merchandise subtotal for a referral code to apply. */
  referralMinimumOrder: number;
  /**
   * The one sentence every surface shows about the attached code, built once.
   * Null when no code is attached.
   */
  referralStatusText: string | null;
  /** True only when a bigger basket would actually unlock something — amber styling. */
  referralNeedsMoreToQualify: boolean;
  /**
   * The referral is the discount actually coming off this basket — it beat
   * every other candidate. NOT "a code is attached", and NOT "the basket is big
   * enough": this is what store credit and points are exclusive of.
   */
  referralDiscountApplied: boolean;
  couponCode: string | null;
  couponDetails: CouponDetails | null;
  couponDiscountAmount: number;
  couponError: string | null;
  couponSuccess: string | null;
  isApplyingReferral: boolean;
  isApplyingCoupon: boolean;
  isSignedIn: boolean;
  pointsBalance: number;
  pointsToEarn: number;
  pointsToRedeem: number;
  pointsRedeemedDiscount: number;
  setPointsToRedeem: (points: number) => void;
  itemCount: number;
  subtotal: number;
  shipping: number;
  taxAmount: number;
  // Admin tax posture (nexus states + per-state overrides) from the promotions
  // config. The cart itself never knows the shipping address, so tax here is
  // always 0 — the checkout page combines this config with the entered address
  // via the shared resolveSalesTax to quote tax live (mirrors the server).
  salesTaxConfig: SalesTaxConfig;
  // Paid membership tiers (marketing summary) for member-pricing display and
  // the join-and-save upsells. memberDiscountPercent > 0 means the signed-in
  // shopper is already an active paying member.
  membershipTiers: MembershipTierSummary[];
  shippingConfig: ShippingConfig;
  bundleConfig: BundleConfig;
  shippingProtectionEnabled: boolean;
  setShippingProtectionEnabled: (enabled: boolean) => void;
  shippingProtectionFee: number;
  discountAmount: number;
  /** Customer-facing name of the applied discount (null when none). */
  appliedDiscountLabel: string | null;
  /** True when the system auto-selected the best available discount. */
  autoBestDiscountApplied: boolean;
  /** How the entered coupon actually fared against the winning discount.
   *  Null when no coupon is entered. */
  couponOutcome: CouponOutcome | null;
  total: number;
  isBuy3Get1FreeActive: boolean;
  isBuy3Get1FreeEligible: boolean;
  buy3Get1UntilNextFree: number;
  bulkSavingsApplied: boolean;
  bulkSavingsTierReached: boolean;
  ambassadorDiscountApplied: boolean;
  ambassadorDiscountPercent: number;
  memberFreeShipping: boolean;
  /** Active paid-member merchandise discount % (0 = not a paying member). */
  memberDiscountPercent: number;
  storeCreditApplied: number;
  storeCreditBalanceCents: number;
  storeCreditMinOrderCents: number;
  bulkSavingsPercent: number;
  bulkSavingsProgress: { nextPercent: number; amountRemaining: number } | null;
  totalQuantity: number;
  addToCart: (
    product: Product,
    quantity?: number,
    sourceElement?: HTMLElement | null,
    options?: {
      variantId?: string;
      doseLabel?: string;
      sku?: string;
      priceOverride?: number;
      imageOverride?: string;
      batchNumberOverride?: string;
      stockStatusOverride?: string;
    },
  ) => void;
  updateQuantity: (slug: string, quantity: number) => void;
  removeFromCart: (slug: string) => void;
  restoreItems: (items: Array<{ slug: string; variantId?: string; name: string; quantity: number; unitPrice: number; image?: string }>) => void;
  clearCart: () => void;
  openCart: () => void;
  closeCart: () => void;
  toggleCart: () => void;
  applyReferralCode: (code: string) => void;
  clearReferralCode: () => void;
  clearReferralMessage: () => void;
  applyCouponCode: (code: string) => void;
  clearCouponCode: () => void;
  clearCouponMessage: () => void;
  setKnownEmail: (email: string) => void;
};

const CartContext = createContext<CartContextValue | undefined>(undefined);

const CART_STORAGE_KEY = "vanta-labs-cart";
const REFERRAL_COOKIE_KEY = "vl_referral_code";
// Hard per-line quantity ceiling for the cart. Prevents absurd quantities
// (999+) that would only fail at order submit, or on untracked inventory be
// silently accepted.
const MAX_LINE_QUANTITY = 99;

function calculateBuy3Get1Discount(items: CartItem[], bundleConfig: BundleConfig = DEFAULT_BUNDLE_CONFIG, useBundledPrices = true) {
  const expandedPrices: number[] = [];
  for (const item of items) {
    // With bundle stacking off, the free item is valued at FULL price and
    // competes with the bundle savings (mirrors payment-service exactly).
    const discountedUnitPrice = useBundledPrices ? getBundleDiscountedUnitPrice(item.price, item.quantity, bundleConfig) : item.price;
    for (let i = 0; i < item.quantity; i += 1) {
      expandedPrices.push(discountedUnitPrice);
    }
  }

  const freeItemCount = Math.floor(expandedPrices.length / 4);
  if (freeItemCount <= 0) {
    return 0;
  }

  expandedPrices.sort((a, b) => a - b);
  return expandedPrices.slice(0, freeItemCount).reduce((sum, price) => sum + price, 0);
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

// Defensively validate persisted cart items. A corrupted or tampered
// localStorage entry (price: null, quantity: "abc", missing slug) would
// otherwise flow into every subtotal as $NaN and leave the cart unrecoverable
// (a NaN quantity can't even be decremented to 0). Drop anything malformed and
// coerce quantities to a sane 1..99, so the cart always renders real numbers.
function sanitizeCartItems(raw: unknown): CartItem[] {
  if (!Array.isArray(raw)) return [];
  const cleaned: CartItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Partial<CartItem>;
    const price = Number(record.price);
    const slug = typeof record.slug === "string" ? record.slug.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!Number.isFinite(price) || price < 0 || !slug || !name) continue;
    const quantity = Math.max(1, Math.min(99, Math.floor(Number(record.quantity))));
    if (!Number.isFinite(quantity)) continue;
    const fallbackKey = record.variantId ? `${slug}::${record.variantId}` : slug;
    cleaned.push({
      key: typeof record.key === "string" && record.key ? record.key : fallbackKey,
      variantId: record.variantId,
      doseLabel: record.doseLabel,
      sku: record.sku,
      slug,
      name,
      price,
      quantity,
      batchNumber: typeof record.batchNumber === "string" ? record.batchNumber : "",
      image: typeof record.image === "string" ? record.image : "",
      stockStatus: typeof record.stockStatus === "string" ? record.stockStatus : "In Stock",
      requiresReconstitution: record.requiresReconstitution === true,
    });
  }
  return cleaned;
}

function isReferralValid(code: ReferralCode) {
  // Honor whatever customer-discount percent the admin has configured (the
  // amount at the call site already uses this value). Hard-coding === 10 made
  // the cart preview silently drop the referral discount — and trip the
  // checkout "total changed" guard — whenever the admin set any other percent.
  return code.customerDiscountPercent > 0 && Boolean(code.ambassadorId);
}

function calculateCouponDiscountAmount(subtotal: number, coupon: CouponDetails | null) {
  if (!coupon || subtotal <= 0 || coupon.discountValue <= 0) {
    return 0;
  }

  const amount = coupon.discountType === "fixed"
    ? coupon.discountValue
    : subtotal * (coupon.discountValue / 100);

  return Math.min(Math.max(amount, 0), subtotal);
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [referralDetails, setReferralDetails] = useState<ReferralCode | null>(null);
  const [referralError, setReferralError] = useState<string | null>(null);
  const [referralSuccess, setReferralSuccess] = useState<string | null>(null);
  const [couponCode, setCouponCode] = useState<string | null>(null);
  const [couponDetails, setCouponDetails] = useState<CouponDetails | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [couponSuccess, setCouponSuccess] = useState<string | null>(null);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [pointsBalance, setPointsBalance] = useState(0);
  const [pointsPerDollar, setPointsPerDollar] = useState(0);
  const [pointsMultiplier, setPointsMultiplier] = useState(1);
  const [pointsToRedeem, setPointsToRedeemState] = useState(0);
  const [promoBuy3Get1Enabled, setPromoBuy3Get1Enabled] = useState(false);
  const [bundleConfig, setBundleConfig] = useState<BundleConfig>(DEFAULT_BUNDLE_CONFIG);
  // Whether quantity "Bundle & Save" pricing stacks with the winning
  // percentage discount. Default FALSE (one discount per order, best wins) —
  // must match the server default in admin-control.ts or totals drift.
  const [bundleStacking, setBundleStacking] = useState(false);
  const [salesTaxConfig, setSalesTaxConfig] = useState<SalesTaxConfig>(DEFAULT_SALES_TAX_CONFIG);
  const [membershipTiers, setMembershipTiers] = useState<MembershipTierSummary[]>([]);
  // Admin-configurable referral customer-discount percent, loaded from the same
  // /api/catalog/promotions config the server uses. Defaults to 10 (matches the
  // server default) until config loads, so the client preview always mirrors the
  // authoritative server discount — a hardcoded value here would trip the
  // anti-tamper "Altered total" guard the moment an admin changed the percent.
  const [referralDiscountPercent, setReferralDiscountPercent] = useState(10);
  // Admin-configured minimum merchandise subtotal to use a referral code —
  // loaded from the same config the server enforces so the client gate matches
  // the real charge (a hardcoded value drifts the moment an admin changes it).
  const [referralMinimumOrder, setReferralMinimumOrder] = useState<number>(DEFAULT_MINIMUM_QUALIFYING_ORDER);
  // THE REFERRAL MASTER SWITCH — null until /api/catalog/promotions answers.
  //
  // quote-order.ts refuses any order still carrying a code while this is off,
  // and until it was carried here the client could not know: the cart previewed
  // and applied the discount, and the shopper was stopped at the pay button.
  // `null` is "not answered yet", NOT "off" — see referral-program-gate.ts for
  // why that distinction is a decision about money rather than a nicety.
  const [referralProgramEnabled, setReferralProgramEnabled] = useState<boolean | null>(null);
  const [shippingConfig, setShippingConfig] = useState<ShippingConfig>(DEFAULT_SHIPPING_CONFIG);
  const [isEligibleForBulkSavings, setIsEligibleForBulkSavings] = useState(false);
  const [bulkSavingsConfig, setBulkSavingsConfig] = useState<BulkSavingsConfig>(DEFAULT_BULK_SAVINGS_CONFIG);
  const [knownEmail, setKnownEmail] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [cartSessionId, setCartSessionId] = useState<string | null>(null);
  const [memberDiscountPercent, setMemberDiscountPercent] = useState(0);
  const [memberFreeShipping, setMemberFreeShipping] = useState(false);
  // Personal discount an approved ambassador gets on their own order (0 for
  // everyone else). Fetched from /api/account/ambassador-discount, which uses
  // the same check as the server so the preview matches the real charge.
  const [ambassadorDiscountPercent, setAmbassadorDiscountPercent] = useState(0);
  const [storeCreditBalanceCents, setStoreCreditBalanceCents] = useState(0);
  const [storeCreditMinOrderCents, setStoreCreditMinOrderCents] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/account/me", { cache: "no-store" });
        if (!response.ok) return;
        const result = await response.json() as {
          success: boolean;
          email?: string;
          fullName?: string;
          pointsBalance?: number;
          pointsPerDollar?: number;
          pointsMultiplier?: number;
          isEligibleForBulkSavings?: boolean;
          memberDiscountPercent?: number;
          memberFreeShipping?: boolean;
          storeCreditBalanceCents?: number;
          storeCreditMinOrderCents?: number;
        };
        if (!result.success) return;
        setIsSignedIn(true);
        setPointsBalance(result.pointsBalance ?? 0);
        setPointsPerDollar(result.pointsPerDollar ?? 0);
        setPointsMultiplier(result.pointsMultiplier ?? 1);
        setIsEligibleForBulkSavings(Boolean(result.isEligibleForBulkSavings));
        setMemberDiscountPercent(Number(result.memberDiscountPercent ?? 0) || 0);
        setMemberFreeShipping(Boolean(result.memberFreeShipping));
        setStoreCreditBalanceCents(Number(result.storeCreditBalanceCents ?? 0) || 0);
        setStoreCreditMinOrderCents(Number(result.storeCreditMinOrderCents ?? 0) || 0);
        if (result.email) setKnownEmail(result.email);
        if (result.fullName) setCustomerName(result.fullName);
      } catch {
        // Guest shoppers simply see no points UI.
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/account/ambassador-discount", { cache: "no-store" });
        if (!response.ok) return;
        const result = await response.json() as { success?: boolean; percent?: number };
        if (result.success) {
          setAmbassadorDiscountPercent(Number(result.percent ?? 0) || 0);
        }
      } catch {
        // Not an ambassador / signed out — no personal discount shown.
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/catalog/promotions", { cache: "no-store" });
        if (!response.ok) return;
        const result = await response.json() as { success: boolean; promoBuy3Get1Enabled?: boolean; referralProgramEnabled?: boolean; bundleConfig?: BundleConfig; bundleStacking?: boolean; salesTax?: SalesTaxConfig; shippingConfig?: ShippingConfig; referralDiscountPercent?: number; referralMinimumOrder?: number; membershipTiers?: MembershipTierSummary[] };
        if (result.success) {
          setPromoBuy3Get1Enabled(Boolean(result.promoBuy3Get1Enabled));
          if (result.bundleConfig) setBundleConfig(result.bundleConfig);
          setBundleStacking(result.bundleStacking === true);
          if (Number.isFinite(result.referralMinimumOrder)) {
            setReferralMinimumOrder(Number(result.referralMinimumOrder));
          }
          // Only a real boolean resolves the state. A payload from an older
          // deploy that omits the field leaves it null, which behaves exactly
          // as this file did before the field existed.
          if (typeof result.referralProgramEnabled === "boolean") {
            setReferralProgramEnabled(result.referralProgramEnabled);
          }
          if (result.salesTax) {
            setSalesTaxConfig({
              nexusStates: Array.isArray(result.salesTax.nexusStates) ? result.salesTax.nexusStates : [],
              rateOverrides: result.salesTax.rateOverrides && typeof result.salesTax.rateOverrides === "object" ? result.salesTax.rateOverrides : {},
            });
          }
          if (result.shippingConfig) setShippingConfig(result.shippingConfig);
          if (Array.isArray(result.membershipTiers)) setMembershipTiers(result.membershipTiers);
          if (Number.isFinite(result.referralDiscountPercent)) {
            setReferralDiscountPercent(Number(result.referralDiscountPercent));
          }
        }
      } catch {
        // Defaults to disabled (matches the server's default) if this fails.
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/catalog/bulk-savings-config", { cache: "no-store" });
        if (!response.ok) return;
        const result = await response.json() as { success: boolean; config?: BulkSavingsConfig };
        if (result.success && result.config) {
          setBulkSavingsConfig(result.config);
        }
      } catch {
        // Defaults to the built-in config if this fails.
      }
    })();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const loadPersistedCart = () => {
      try {
        const stored = window.localStorage.getItem(CART_STORAGE_KEY);

        if (stored) {
          const parsed = JSON.parse(stored) as {
            items?: CartItem[];
            referralCode?: string | null;
          };

          if (Array.isArray(parsed.items)) {
            setItems(sanitizeCartItems(parsed.items));
          }

          if (typeof parsed.referralCode === "string") {
            setReferralCode(parsed.referralCode);
          }
        }

        const params = new URLSearchParams(window.location.search);
        const referralFromUrl = params.get("ref") || params.get("referral");
        const referralFromCookie = document.cookie
          .split("; ")
          .find((entry) => entry.startsWith(`${REFERRAL_COOKIE_KEY}=`))
          ?.split("=")[1];

        const discoveredReferralCode = referralFromUrl || referralFromCookie;

        if (discoveredReferralCode) {
          setReferralCode(decodeURIComponent(discoveredReferralCode));
        }

        if (referralFromUrl) {
          params.delete("ref");
          params.delete("referral");
          const query = params.toString();
          const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
          window.history.replaceState({}, "", nextUrl);
        }
        const CART_SESSION_KEY = "vanta-labs-cart-session-id";
        let sessionId = window.localStorage.getItem(CART_SESSION_KEY);
        if (!sessionId) {
          sessionId = crypto.randomUUID();
          window.localStorage.setItem(CART_SESSION_KEY, sessionId);
        }
        setCartSessionId(sessionId);
      } catch (error) {
        console.error("Unable to read cart state", error);
      } finally {
        setIsHydrated(true);
      }
    };

    loadPersistedCart();

    // Cross-tab sync: when another tab writes the cart (adds an item, or empties
    // it after checkout), mirror that here. Without this, a second tab holds a
    // stale in-memory cart and can "resurrect" a just-purchased cart or clobber
    // the other tab's changes on its next save (last-writer-wins).
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== CART_STORAGE_KEY) return;
      try {
        if (!event.newValue) {
          setItems([]);
          return;
        }
        const parsed = JSON.parse(event.newValue) as { items?: unknown; referralCode?: string | null };
        setItems(sanitizeCartItems(parsed.items));
        if (typeof parsed.referralCode === "string" || parsed.referralCode === null) {
          setReferralCode(parsed.referralCode ?? null);
        }
      } catch {
        // Ignore a malformed cross-tab write; our own state stays intact.
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleFlyToCart = (event: Event) => {
      const customEvent = event as CustomEvent<{
        image?: string;
        name?: string;
        fromRect?: DOMRect | null;
      }>;

      const cartTrigger = document.getElementById("site-cart-trigger");
      const fromRect = customEvent.detail?.fromRect;

      if (!cartTrigger || !fromRect) {
        return;
      }

      const toRect = cartTrigger.getBoundingClientRect();
      const node = document.createElement("div");
      node.className = "vanta-fly-node";
      node.style.position = "fixed";
      node.style.left = `${fromRect.left + fromRect.width / 2 - 18}px`;
      node.style.top = `${fromRect.top + fromRect.height / 2 - 18}px`;
      node.style.width = "36px";
      node.style.height = "36px";
      node.style.borderRadius = "999px";
      node.style.zIndex = "1000";
      node.style.pointerEvents = "none";
      node.style.border = "1px solid rgba(255,255,255,0.35)";
      node.style.boxShadow = "0 8px 24px rgba(0,0,0,0.45)";
      node.style.overflow = "hidden";
      node.style.background = "radial-gradient(circle at 30% 20%, rgba(255,255,255,0.5), rgba(138,180,255,0.8))";

      const image = customEvent.detail?.image;
      if (image && !image.includes(".svg")) {
        const imgNode = document.createElement("img");
        imgNode.src = image;
        imgNode.alt = customEvent.detail?.name ?? "product";
        imgNode.style.width = "100%";
        imgNode.style.height = "100%";
        imgNode.style.objectFit = "cover";
        node.appendChild(imgNode);
      }

      document.body.appendChild(node);

      const deltaX = toRect.left + toRect.width / 2 - (fromRect.left + fromRect.width / 2);
      const deltaY = toRect.top + toRect.height / 2 - (fromRect.top + fromRect.height / 2);

      node.animate(
        [
          { transform: "translate3d(0, 0, 0) scale(1)", opacity: 0.95 },
          { transform: `translate3d(${deltaX * 0.7}px, ${deltaY * 0.25}px, 0) scale(0.88)`, opacity: 0.9 },
          { transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(0.32)`, opacity: 0.35 },
        ],
        { duration: 650, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      ).onfinish = () => {
        node.remove();
      };

      cartTrigger.animate(
        [
          { transform: "scale(1)" },
          { transform: "scale(1.06)" },
          { transform: "scale(1)" },
        ],
        { duration: 420, easing: "ease-out" },
      );
    };

    window.addEventListener("vanta:cart-fly", handleFlyToCart as EventListener);
    return () => {
      window.removeEventListener("vanta:cart-fly", handleFlyToCart as EventListener);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !isHydrated) {
      return;
    }

    try {
      window.localStorage.setItem(
        CART_STORAGE_KEY,
        JSON.stringify({ items, referralCode }),
      );
    } catch (error) {
      console.error("Unable to save cart state", error);
    }
  }, [items, referralCode, isHydrated]);

  useEffect(() => {
    if (!isHydrated || !referralCode || referralDetails) {
      return;
    }
    // The programme is off: do not resolve the code into a discount. This is
    // the path an ambassador's own link takes (cookie -> referralCode ->
    // details), and it is where the cart used to start advertising a saving
    // that quote-order would refuse at the pay button.
    //
    // Deliberately NOT the moment to discard the code — see the effect below.
    // While the answer is still null this behaves exactly as it always did.
    if (!referralProgramAllowsCodes(referralProgramEnabled)) {
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const validatedReferral = await validateReferralCodeClient(referralCode);
        if (!validatedReferral || cancelled) {
          return;
        }

        setReferralDetails({
          code: validatedReferral.referralCode,
          // HER rate, resolved against the program default by the same function
          // the server uses. This used to be the program-wide number alone,
          // which is how a 15% ambassador's customers were offered 10%.
          customerDiscountPercent: resolveAmbassadorCustomerDiscount(
            validatedReferral.customerDiscountPercent,
            referralDiscountPercent,
          ),
          ambassadorName: validatedReferral.ambassadorName,
          ambassadorId: validatedReferral.ambassadorId,
        });
      } catch {
        if (!cancelled) {
          setReferralDetails(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isHydrated, referralCode, referralDetails, referralProgramEnabled]);

  // A DEFINITE "OFF" CLEARS THE CODE, AND ONLY A DEFINITE ONE.
  //
  // Leaving it attached means it is still posted to create-session, which is
  // exactly the 400 this fix exists to remove. Clearing it makes the server's
  // throw unreachable from the UI — where it stays, as the backstop against a
  // crafted or stale request.
  //
  // The COOKIE is left alone on purpose. It is how the ambassador's link is
  // remembered, so turning the programme back on re-attaches the code on the
  // next load and her referral is restored rather than lost. No error is shown:
  // the shopper did nothing wrong and asked for nothing here. Typing a code
  // deliberately is the case that gets an answer, in applyReferralCode.
  //
  // Adjusted DURING RENDER rather than in an effect — React's documented
  // "adjusting state when props change" pattern, the same one cart-drawer.tsx
  // uses for its codes row. One render pass instead of two, and the condition
  // is false immediately afterwards, so it cannot loop.
  if (isHydrated && referralProgramIsOff(referralProgramEnabled) && (referralCode !== null || referralDetails !== null)) {
    setReferralCode(null);
    setReferralDetails(null);
  }

  const itemCount = useMemo(() => items.reduce((sum, item) => sum + item.quantity, 0), [items]);

  const subtotal = useMemo(
    () => items.reduce((sum, item) => sum + getBundleDiscountedLineTotal(item.price, item.quantity, bundleConfig), 0),
    [items, bundleConfig],
  );

  // Full-price subtotal and the dollars the quantity "Bundle & Save" tiers
  // already saved inside `subtotal`. With bundle stacking OFF (default),
  // every percentage discount is computed on the full base and only applies
  // for what it saves BEYOND the bundle — one discount per order, best wins.
  // Mirrors payment-service.ts exactly (rounding included) so the preview
  // can never fall below the server's authoritative total.
  const fullSubtotal = useMemo(
    () => items.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [items],
  );
  const quantityBundleSavings = bundleStacking ? 0 : Math.round(Math.max(0, fullSubtotal - subtotal) * 100) / 100;
  const discountBase = bundleStacking ? subtotal : fullSubtotal;

  // Abandoned-cart-recovery tracking: fires a debounced snapshot only for a
  // SIGNED-IN shopper. /api/cart/track is auth-gated and always sources the
  // email from the session, so posting a guest's typed email did nothing but
  // ship their PII + full cart to the server pointlessly — we no longer send
  // the email at all, and skip the effect entirely for guests. Fire-and-forget.
  useEffect(() => {
    if (!isSignedIn || !cartSessionId || items.length === 0) {
      return;
    }

    const timeout = setTimeout(() => {
      fetch("/api/cart/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: cartSessionId,
          customerName: customerName || undefined,
          items: items.map((item) => ({
            slug: item.slug,
            variantId: item.variantId,
            name: item.name,
            quantity: item.quantity,
            unitPrice: item.price,
            image: item.image,
          })),
          cartValueCents: Math.round(subtotal * 100),
        }),
      }).catch(() => {
        // Non-fatal - the cart itself is unaffected either way.
      });
    }, 1500);

    return () => clearTimeout(timeout);
  }, [isSignedIn, cartSessionId, items, customerName, subtotal]);

  const totalQuantity = useMemo(() => items.reduce((sum, item) => sum + item.quantity, 0), [items]);
  const isBuy3Get1FreeEligible = useMemo(
    () => promoBuy3Get1Enabled && totalQuantity >= 4,
    [totalQuantity, promoBuy3Get1Enabled],
  );
  // How many more items unlock the next free one (0 when the promo is off, the
  // cart is empty, or a group of 4 is already complete).
  const buy3Get1UntilNextFree = useMemo(() => {
    if (!promoBuy3Get1Enabled || totalQuantity <= 0) return 0;
    const remainder = totalQuantity % 4;
    return remainder === 0 ? 0 : 4 - remainder;
  }, [promoBuy3Get1Enabled, totalQuantity]);
  const buy3Get1FreeDiscount = useMemo(
    () => (promoBuy3Get1Enabled ? calculateBuy3Get1Discount(items, bundleConfig, bundleStacking) : 0),
    [items, promoBuy3Get1Enabled, bundleConfig, bundleStacking],
  );

  // Reaching a bulk-savings tier grants free shipping on the server
  // (payment-service.ts) regardless of which discount ultimately wins, so the
  // client preview must mirror that or the server total diverges and trips the
  // "Altered total detected" guard (notably for international bulk-eligible
  // orders). This is a distinct check from bulkSavingsApplied below (which is
  // about which discount wins the "greatest savings" contest).
  const bulkSavingsTierReached = useMemo(
    () => calculateBulkSavingsDiscount(discountBase, isEligibleForBulkSavings, bulkSavingsConfig).tier != null,
    [discountBase, isEligibleForBulkSavings, bulkSavingsConfig],
  );

  // Estimate only - no shipping address is known yet in the cart, so this
  // assumes domestic. checkout/page.tsx recomputes this from the shared
  // shipping.ts formula once the customer enters their country, and that
  // recomputed value (not this one) is what's sent to the server.
  const shipping = (bulkSavingsTierReached || memberFreeShipping) ? 0 : calculateShipping(subtotal, undefined, shippingConfig);

  const couponDiscountAmount = useMemo(
    () => (buy3Get1FreeDiscount > 0 || referralDetails ? 0 : calculateCouponDiscountAmount(discountBase, couponDetails)),
    [buy3Get1FreeDiscount, referralDetails, couponDetails, discountBase],
  );

  // Whichever of buy3get1 / referral / coupon the customer is actually
  // eligible for under the existing (unchanged) mutual-exclusivity rules
  // between those three.
  // BUNDLE OR REFERRAL — but the coupon is NOT part of this choice.
  //
  // This used to end `return { type: "coupon", amount: couponDiscountAmount }`,
  // which made the coupon the third rung of a priority chain: a Buy-3-Get-1
  // bundle short-circuited above it and the coupon never competed at all.
  // resolveCustomerDiscount, which decides what the CARD is charged, pushes
  // bundleDiscount and couponDiscount into the candidate list together and
  // takes the larger. So a $20 free item plus a $50 coupon showed $20 off in
  // the cart and charged $50 off — the shopper paying less than the page said,
  // and the "best discount applied" line naming the wrong one.
  //
  // Bundle-over-referral IS correct and stays: the server suppresses the
  // referral bucket outright when a bundle is present
  // (`!isBundle && hasReferral`), because the free item is the whole discount.
  // Only the coupon was wrongly excluded, so only the coupon moves out — into
  // its own candidate below, where it competes exactly as it does server-side.
  const promoDiscount = useMemo(() => {
    if (buy3Get1FreeDiscount > 0) {
      return { type: "buy3get1" as const, amount: buy3Get1FreeDiscount };
    }
    // Belt and braces against the single frame between the config landing
    // "off" and the clearing effect below running: the cart must never price a
    // referral the server is about to refuse, not even once.
    if (referralDetails && isReferralValid(referralDetails) && referralProgramAllowsCodes(referralProgramEnabled)) {
      // THE AMBASSADOR'S OWN RATE, resolved when the code was applied by the
      // same resolveAmbassadorCustomerDiscount the server uses, with the live
      // program default as the fallback for anyone who has no override.
      //
      // This used to read the program-wide percent directly, on the reasoning
      // that a live value cannot go stale. It cannot — but it was never her
      // number: a 15% ambassador's customers were quoted the program's 10%
      // while checkout charged 15%.
      //
      // Below the minimum qualifying order the server gives no referral
      // discount either (quote-order.ts gates on the SAME referralQualifies
      // rule this line uses), so the referral does not compete until the basket
      // qualifies. It no longer REFUSES the order — that hard block turned an
      // ambassador's link into a checkout blocker — which is why the cart must
      // now say what is actually true: see referralMeetsMinimum below.
      if (!referralQualifies(subtotal, referralMinimumOrder)) {
        return null;
      }
      return { type: "referral" as const, amount: discountBase * (referralDetails.customerDiscountPercent / 100) };
    }
    return null;
  }, [buy3Get1FreeDiscount, referralDetails, discountBase, subtotal, referralMinimumOrder, referralProgramEnabled]);


  // The elite "Exclusive Buy In Bulk Savings" benefit cannot stack with
  // anything else - it competes with whatever the customer would otherwise
  // get, and the single largest discount wins (see src/lib/discount-resolution.ts).
  const bulkSavingsResult = useMemo(
    () => calculateBulkSavingsDiscount(discountBase, isEligibleForBulkSavings, bulkSavingsConfig),
    [discountBase, isEligibleForBulkSavings, bulkSavingsConfig],
  );

  const memberPricingAmount = useMemo(
    () => (memberDiscountPercent > 0 ? discountBase * (memberDiscountPercent / 100) : 0),
    [memberDiscountPercent, discountBase],
  );

  // Ambassadors get a personal discount on their own order (no commission). It
  // competes for best value with everything else — a bigger coupon wins, and it
  // never stacks. Mirrors payment-service.ts.
  const ambassadorPersonalAmount = useMemo(
    () => (ambassadorDiscountPercent > 0 ? discountBase * (ambassadorDiscountPercent / 100) : 0),
    [ambassadorDiscountPercent, discountBase],
  );

  // One discount, best wins — each competing for what it saves BEYOND the
  // bundle pricing already in the subtotal.
  //
  // Assembled in lib/discount-resolution.ts, not here. It used to live inline,
  // which is precisely why it could drift from the server without any test
  // noticing: nothing can import a candidate list built inside a component.
  const cartDiscount = useMemo(
    () => resolveCartDiscount({
      subtotal,
      quantityBundleSavings,
      bulkSavingsAmount: bulkSavingsResult.amount,
      memberPricingAmount,
      ambassadorPersonalAmount,
      couponDiscountAmount,
      promo: promoDiscount,
    }),
    [subtotal, quantityBundleSavings, bulkSavingsResult.amount, memberPricingAmount, ambassadorPersonalAmount, couponDiscountAmount, promoDiscount],
  );

  const bestDiscount = cartDiscount.best;
  const discountAmount = cartDiscount.amount;

  // WHAT THE CART IS ALLOWED TO CLAIM.
  //
  // referralDetails alone means "this code is real and belongs to an approved
  // ambassador" — it does NOT mean the basket earns anything. The cart used to
  // render "Ambassador X - 15% customer discount" off referralDetails alone, so
  // a shopper who followed an ambassador's link with a $39.99 basket was
  // promised a discount, given none, and then refused at the pay button.
  //
  // Worked out by referralCartStatus rather than here, for the reason
  // resolveCartDiscount was lifted out of this file: a decision that lives
  // inside a component cannot be imported, so it cannot be tested, so its
  // copies drift.
  //
  // IT SITS BELOW resolveCartDiscount ON PURPOSE. The question the sentence and
  // the exclusivity gates both need is "is the referral the discount actually
  // coming off this basket", and only the resolved winner answers it. Asking
  // "is the basket over $100" instead announced a 15% discount on a five-vial
  // cart whose quantity-bundle pricing had already competed the referral to
  // $0.00 — and suppressed the shopper's store credit to pay for it.
  const referralStatus = useMemo(
    () => (referralDetails && referralProgramAllowsCodes(referralProgramEnabled)
      ? referralCartStatus({
        ambassadorName: referralDetails.ambassadorName,
        discountPercent: referralDetails.customerDiscountPercent,
        subtotal,
        minimumQualifyingOrder: referralMinimumOrder,
        referralDiscountApplied: bestDiscount?.type === "referral" && discountAmount > 0,
        competingDiscountApplied: Boolean(bestDiscount) && bestDiscount?.type !== "referral" && discountAmount > 0,
        formatCurrency: formatCartCurrency,
      })
      : null),
    [referralDetails, subtotal, referralMinimumOrder, bestDiscount, discountAmount, referralProgramEnabled],
  );
  const referralStatusText = referralStatus?.line ?? null;
  const referralNeedsMoreToQualify = Boolean(referralStatus?.needsMoreToQualify);
  /** The referral is the discount actually coming off this basket. */
  const referralDiscountApplied = Boolean(referralStatus?.referralDiscountApplied);

  // Customer-facing name for the applied discount, and the "we picked the
  // best one for you" note shown when an entered code lost to something
  // bigger (or the cart's bundle pricing beat every percentage discount).
  const appliedDiscountLabel = useMemo(() => {
    if (discountAmount > 0 && bestDiscount) {
      switch (bestDiscount.type) {
        case "member_pricing": return "Membership discount";
        case "coupon": return couponDetails ? `Promo code ${couponDetails.code}` : "Promo code";
        case "referral": return referralDetails ? `Ambassador code ${referralDetails.code}` : "Ambassador code";
        case "ambassador_personal": return "Ambassador discount";
        case "bulk_savings": return "Bulk savings";
        case "buy3get1": return "Buy 3 Get 1 Free";
        default: return "Discount";
      }
    }
    return quantityBundleSavings > 0 ? "Bundle pricing" : null;
  }, [discountAmount, bestDiscount, couponDetails, referralDetails, quantityBundleSavings]);

  const autoBestDiscountApplied = useMemo(() => {
    const winner = discountAmount > 0 ? bestDiscount?.type : (quantityBundleSavings > 0 ? "bundle_pricing" : null);
    if (!winner) return false;
    if (couponDetails && winner !== "coupon") return true;
    if (referralDetails && winner !== "referral") return true;
    // A member whose tier discount won without entering anything also gets the
    // reassurance line — their best discount was applied automatically.
    return winner === "member_pricing";
  }, [discountAmount, bestDiscount, quantityBundleSavings, couponDetails, referralDetails]);
  // WHAT THE SHOPPER IS TOLD ABOUT THE CODE THEY ENTERED.
  //
  // The success message used to be the constant "Coupon applied.", set the
  // moment the code validated — before anything knew whether it would actually
  // win. A 10% code entered on the 12% bundle tier therefore reported itself as
  // applied next to a total it had not moved. Derived here, from the same
  // winner the price is derived from, so the copy cannot disagree with the maths.
  const couponOutcome = useMemo<CouponOutcome | null>(() => {
    if (!couponDetails) return null;
    const winnerType: PriceControllingDiscount | null =
      discountAmount > 0 && bestDiscount
        ? bestDiscount.type
        : quantityBundleSavings > 0
          ? "bundle_pricing"
          : null;
    return describeCouponOutcome({
      code: couponDetails.code,
      offerLabel:
        couponDetails.discountType === "fixed"
          ? `${formatCurrency(couponDetails.discountValue)} off`
          : `${couponDetails.discountValue}% off`,
      winnerType,
      winnerLabel: appliedDiscountLabel,
    });
  }, [couponDetails, discountAmount, bestDiscount, quantityBundleSavings, appliedDiscountLabel]);

  const bulkSavingsApplied = bestDiscount?.type === "bulk_savings";
  const ambassadorDiscountApplied = bestDiscount?.type === "ambassador_personal";
  const bulkSavingsProgress = useMemo(
    () => getBulkSavingsProgress(subtotal, isEligibleForBulkSavings, bulkSavingsConfig),
    [subtotal, isEligibleForBulkSavings, bulkSavingsConfig],
  );

  const pointsToEarn = useMemo(
    () => (isSignedIn ? calculateEarnedPoints(Math.max(0, subtotal - discountAmount), pointsPerDollar, pointsMultiplier) : 0),
    [isSignedIn, subtotal, discountAmount, pointsPerDollar, pointsMultiplier],
  );

  // Sales tax is address-based and the cart has no address yet, so the cart
  // preview carries $0 tax — the drawer says "calculated at checkout" and the
  // checkout page quotes the real figure live from the entered shipping
  // address (shared resolveSalesTax, mirroring payment-service.ts exactly).
  const taxAmount = 0;

  const totalBeforePoints = Math.max(0, subtotal + shipping + taxAmount - discountAmount);

  // Membership store credit auto-applies when the merchandise subtotal meets
  // the tier's redemption minimum. Mirrors payment-service.ts exactly.
  // The arithmetic is in store-credit-redemption.ts, shared verbatim with
  // quote-order.ts. It used to be a hand-written copy here and a second one in
  // checkout/page.tsx; reverting either of them left the whole suite green,
  // because nothing renders this provider.
  const storeCreditApplied = useMemo(
    () => resolveStoreCreditCents({
      referralDiscountApplied,
      balanceCents: storeCreditBalanceCents,
      minOrderCents: storeCreditMinOrderCents,
      subtotalCents: Math.round(subtotal * 100),
      redeemableCents: Math.round(totalBeforePoints * 100),
    }) / 100,
    [referralDiscountApplied, storeCreditBalanceCents, storeCreditMinOrderCents, subtotal, totalBeforePoints],
  );

  const totalAfterCredit = Math.max(0, totalBeforePoints - storeCreditApplied);

  // Points are exclusive of a referral DISCOUNT, not of an attached code —
  // same shared rule, same reason as store credit above.
  const pointsRedeemedDiscount = useMemo(
    () => resolvePointsRedemptionCents({
      referralDiscountApplied,
      requestedCents: Math.round(pointsToDollars(pointsToRedeem) * 100),
      redeemableCents: Math.round(totalAfterCredit * 100),
    }) / 100,
    [referralDiscountApplied, pointsToRedeem, totalAfterCredit],
  );

  // Shipping-protection add-on (loss/theft/damage). Added by DEFAULT — the
  // cart and checkout both show it as a visible, pre-checked line item with
  // its fee, and one untick removes it (still strictly optional). Fee is a
  // percentage of the merchandise subtotal (shipping-protection.ts), mirrored
  // exactly by the server (payment-service) so preview == charge.
  // OFF BY DEFAULT, because the published Shipping Policy says so in the store's
  // own words: Shipping Protection "is off by default and never pre-selected".
  // This was useState(true), so a paid add-on was pre-ticked on every cart and
  // added shipping_protection_fee to the total unless the shopper noticed and
  // unticked it - a specific negative promise contradicted by the code, on a
  // control that takes the customer's money.
  //
  // If the business wants it pre-selected, that is a product decision AND an edit
  // to legal-content.ts's shipping policy, made together. Not one without the other.
  const [shippingProtectionEnabled, setShippingProtectionEnabled] = useState(false);
  const shippingProtectionFee = shippingProtectionEnabled ? calculateShippingProtectionFee(subtotal) : 0;

  const total = Math.max(0, totalAfterCredit - pointsRedeemedDiscount) + shippingProtectionFee;

  const setPointsToRedeem = (points: number) => {
    const clamped = Math.max(0, Math.min(Math.floor(points), pointsBalance));
    setPointsToRedeemState(clamped);
  };

  const addToCart = (
    product: Product,
    quantity = 1,
    sourceElement?: HTMLElement | null,
    options?: {
      variantId?: string;
      doseLabel?: string;
      sku?: string;
      priceOverride?: number;
      imageOverride?: string;
      batchNumberOverride?: string;
      stockStatusOverride?: string;
    },
  ) => {
    // A product sold in doses is ALWAYS bought as one of them. The catalogue
    // grid's Add to Cart has no dose picker and passes no options, which used to
    // create a variant-less line: it priced fine (the card shows the default
    // dose's price) but it was a different cart key from the same dose added on
    // the product page, so the two never merged, and the packing slip named no
    // strength. Resolving the default dose here — the one place every caller
    // funnels through — makes a grid add and a product-page add the same line.
    const fallbackDose = !options?.variantId
      ? product.doses?.find((dose) => dose.isDefault) ?? product.doses?.[0]
      : undefined;
    const resolved = fallbackDose
      ? {
          variantId: fallbackDose.id,
          doseLabel: fallbackDose.label,
          sku: fallbackDose.sku,
          priceOverride: Number((fallbackDose.salePrice ?? fallbackDose.price).replace(/[^0-9.]/g, "")),
          imageOverride: fallbackDose.imageUrl,
          batchNumberOverride: fallbackDose.batchNumber,
          stockStatusOverride: fallbackDose.stockStatus,
          ...options,
        }
      : options;

    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("vanta:cart-fly", {
          detail: {
            image: resolved?.imageOverride ?? product.image,
            name: product.name,
            fromRect: sourceElement?.getBoundingClientRect() ?? null,
          },
        }),
      );

      window.dispatchEvent(
        new CustomEvent("vanta:analytics", {
          detail: {
            eventType: "add_to_cart",
            productSlug: product.slug,
            variantId: resolved?.variantId ?? null,
            // Descriptive only. Measurement reads these to label the product in
            // ad reporting; nothing in the cart depends on them.
            productName: product.name,
            productCategory: product.category,
            variantLabel: resolved?.doseLabel ?? null,
            // Carried on the event because the BAC Water sheet reacts to this
            // dispatch synchronously, before React has re-rendered and updated
            // the cart it would otherwise have to look the product up in.
            // Reading the flag from a stale cart is how the sheet silently
            // never fired.
            requiresReconstitution: product.requiresReconstitution === true,
            quantity,
            price: (resolved?.priceOverride ?? Number(product.price.replace(/[^0-9.]/g, ""))) || 0,
          },
        }),
      );
    }

    setItems((currentItems) => {
      const variantKey = resolved?.variantId ? `${product.slug}::${resolved.variantId}` : product.slug;
      const existing = currentItems.find((item) => item.key === variantKey);
      if (existing) {
        return currentItems.map((item) =>
          item.key === variantKey
            ? { ...item, quantity: item.quantity + quantity }
            : item,
        );
      }
      const parsedPrice = resolved?.priceOverride ?? Number(product.price.replace(/[^0-9.]/g, ""));
      return [
        ...currentItems,
        {
          key: variantKey,
          variantId: resolved?.variantId,
          doseLabel: resolved?.doseLabel,
          sku: resolved?.sku,
          slug: product.slug,
          name: product.name,
          price: Number.isFinite(parsedPrice) ? parsedPrice : 0,
          quantity,
          batchNumber: resolved?.batchNumberOverride ?? product.batchNumber,
          image: resolved?.imageOverride ?? product.image,
          stockStatus: resolved?.stockStatusOverride ?? product.stockStatus,
          requiresReconstitution: product.requiresReconstitution === true,
        },
      ];
    });
    clearCodeMessages();
    // Intentionally do NOT open the cart here — the fly-to-cart animation and
    // the updated cart badge confirm the add, and the shopper keeps browsing
    // instead of being pulled into the cart on every add.
  };

  /**
   * Drop the one-shot apply/error messages.
   *
   * They are strings captured at the moment a code was applied, and two of them
   * quote a figure derived from the basket at that moment. Any change to the
   * basket can make them false, and they render immediately above the live
   * status line that has already updated.
   */
  const clearCodeMessages = () => {
    setReferralError(null);
    setReferralSuccess(null);
  };

  const updateQuantity = (slug: string, quantity: number) => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("vanta:analytics", {
          detail: {
            eventType: "update_cart_quantity",
            slug,
            quantity,
          },
        }),
      );
    }

    setItems((currentItems) => {
      // Match on the unique cart key ONLY. Matching on slug too would let an
      // action on a no-variant item collide with that product's variant row.
      if (quantity <= 0) {
        return currentItems.filter((item) => item.key !== slug);
      }
      // Clamp to a sane per-line maximum so a shopper can't tap "+" up to 999
      // and only discover the problem at order submit (the PDP already caps
      // per-vial quantity at its bundle tiers; this is the cart-side backstop).
      const clamped = Math.min(Math.max(1, Math.floor(quantity)), MAX_LINE_QUANTITY);
      return currentItems.map((item) => (item.key === slug ? { ...item, quantity: clamped } : item));
    });
    // The apply confirmation is BASKET-DEPENDENT — "Referral code saved — 15%
    // off unlocks at $100.00. Add $31.00 to qualify." — and it is a one-shot
    // string, not derived state. Changing the basket makes it stale, and it
    // renders directly above the live status line, so a shopper stepping down
    // from two vials to one saw "Referral code applied — 15% off." in emerald
    // immediately above "add $31.00 to unlock it" in amber. addItem already
    // cleared it; the two mutators that can INVALIDATE it did not.
    clearCodeMessages();
  };

  const removeFromCart = (slug: string) => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("vanta:analytics", {
          detail: {
            eventType: "remove_from_cart",
            slug,
          },
        }),
      );
    }

    setItems((currentItems) => currentItems.filter((item) => item.key !== slug));
    // Same reason as updateQuantity above.
    clearCodeMessages();
  };

  // Used by /cart/restore - replaces the current cart with a recovered
  // abandoned-cart snapshot. Checkout always re-resolves real price/stock
  // from the DB server-side, so a stale display price here never affects
  // what's actually charged.
  const restoreItems = (restoredItems: Array<{ slug: string; variantId?: string; name: string; quantity: number; unitPrice: number; image?: string }>) => {
    setItems(
      restoredItems.map((item) => ({
        key: item.variantId ? `${item.slug}::${item.variantId}` : item.slug,
        variantId: item.variantId,
        slug: item.slug,
        name: item.name,
        price: item.unitPrice,
        quantity: item.quantity,
        batchNumber: "",
        image: item.image ?? "",
        stockStatus: "In Stock",
        // Not carried on this payload; false suppresses the upsell rather
        // than guessing that a restored line was lyophilized.
        requiresReconstitution: false,
      })),
    );
  };

  const clearCart = () => {
    setItems([]);
    setReferralCode(null);
    setReferralDetails(null);
    setReferralError(null);
    setReferralSuccess(null);
    setCouponCode(null);
    setCouponDetails(null);
    setCouponError(null);
    setCouponSuccess(null);
    setPointsToRedeemState(0);
  };

  const openCart = () => setIsCartOpen(true);
  const closeCart = () => setIsCartOpen(false);
  const toggleCart = () => setIsCartOpen((current) => !current);

  const [isApplyingReferral, setIsApplyingReferral] = useState(false);
  const [isApplyingCoupon, setIsApplyingCoupon] = useState(false);

  const applyReferralCode = async (code: string) => {
    if (isApplyingReferral) return; // ignore rapid re-clicks while validating
    const normalized = code.trim().toUpperCase();

    // Typed deliberately, so this one gets a straight answer rather than a
    // silent no-op. Not "invalid code": the code is real and so is the
    // ambassador behind it.
    if (referralProgramIsOff(referralProgramEnabled)) {
      setReferralDetails(null);
      setReferralCode(null);
      setReferralSuccess(null);
      setReferralError(REFERRAL_PROGRAM_PAUSED_MESSAGE);
      return;
    }

    if (buy3Get1FreeDiscount > 0) {
      setReferralDetails(null);
      setReferralCode(null);
      setReferralError("Referral codes cannot be combined with the Buy 3 Get 1 Free promotion.");
      setReferralSuccess(null);
      return;
    }

    if (!normalized) {
      setReferralDetails(null);
      setReferralCode(null);
      setReferralError("Enter a referral code.");
      setReferralSuccess(null);
      return;
    }

    setIsApplyingReferral(true);
    try {
      const validatedReferral = await validateReferralCodeClient(normalized);

      if (!validatedReferral) {
        setReferralDetails(null);
        setReferralCode(null);
        setReferralError("That referral code is not active.");
        setReferralSuccess(null);
        return;
      }

      const appliedPercent = resolveAmbassadorCustomerDiscount(
        validatedReferral.customerDiscountPercent,
        referralDiscountPercent,
      );

      const details: ReferralCode = {
        code: validatedReferral.referralCode,
        customerDiscountPercent: appliedPercent,
        ambassadorName: validatedReferral.ambassadorName,
        ambassadorId: validatedReferral.ambassadorId,
      };

      setReferralDetails(details);
      setReferralCode(validatedReferral.referralCode);
      setReferralError(null);
      // Quote the rate actually applied, not the program default — the two
      // differ for every ambassador with an override.
      //
      // And say which state this is. Apply used to REFUSE a code below the
      // minimum, clearing it and blocking with an error — so the same code
      // behaved differently depending on whether it was typed or arrived from a
      // link, and after the server stopped refusing below-minimum orders the
      // refusal disagreed with the server too. The code is kept either way now;
      // this sentence is what tells the shopper which one they are in.
      setReferralSuccess(referralAppliedMessage({
        discountPercent: appliedPercent,
        meetsMinimum: referralQualifies(subtotal, referralMinimumOrder),
        amountToQualify: referralShortfall(subtotal, referralMinimumOrder),
        minimumOrder: referralMinimumOrder,
        formatCurrency,
      }));
      setCouponCode(null);
      setCouponDetails(null);
      setCouponError(null);
      setCouponSuccess(null);
      setPointsToRedeemState(0);
      if (typeof document !== "undefined") {
        document.cookie = `${REFERRAL_COOKIE_KEY}=${encodeURIComponent(validatedReferral.referralCode)}; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`;
      }
    } catch (error) {
      console.error("Unable to validate referral code", error);
      setReferralDetails(null);
      setReferralCode(null);
      setReferralError("Unable to check the referral code right now.");
      setReferralSuccess(null);
    } finally {
      setIsApplyingReferral(false);
    }
  };

  const clearReferralCode = () => {
    setReferralCode(null);
    setReferralDetails(null);
    setReferralError(null);
    setReferralSuccess("Referral code removed.");
    if (typeof document !== "undefined") {
      document.cookie = `${REFERRAL_COOKIE_KEY}=; path=/; max-age=0; samesite=lax`;
    }
  };

  const clearReferralMessage = () => {
    setReferralError(null);
    setReferralSuccess(null);
  };

  const applyCouponCode = async (code: string) => {
    if (isApplyingCoupon) return; // ignore rapid re-clicks while validating
    const normalized = code.trim().toUpperCase();

    if (buy3Get1FreeDiscount > 0) {
      setCouponDetails(null);
      setCouponCode(null);
      setCouponError("Coupon codes cannot be combined with the Buy 3 Get 1 Free promotion.");
      setCouponSuccess(null);
      return;
    }

    if (!normalized) {
      setCouponDetails(null);
      setCouponCode(null);
      setCouponError("Enter a coupon code.");
      setCouponSuccess(null);
      return;
    }

    setIsApplyingCoupon(true);
    try {
      const response = await fetch("/api/coupons/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: normalized, subtotal }),
      });
      const result = await response.json() as {
        success: boolean;
        code?: string;
        discountType?: "percent" | "fixed";
        discountValue?: number;
        error?: string;
      };

      if (!result.success || !result.code || !result.discountType) {
        setCouponDetails(null);
        setCouponCode(null);
        setCouponError(result.error || "That coupon code is not valid.");
        setCouponSuccess(null);
        return;
      }

      setCouponDetails({
        code: result.code,
        discountType: result.discountType,
        discountValue: Number(result.discountValue ?? 0),
      });
      setCouponCode(result.code);
      setCouponError(null);
      setCouponSuccess("Coupon applied.");
      setReferralDetails(null);
      setReferralCode(null);
      setReferralError(null);
      setReferralSuccess(null);
      if (typeof document !== "undefined") {
        document.cookie = `${REFERRAL_COOKIE_KEY}=; path=/; max-age=0; samesite=lax`;
      }
    } catch (error) {
      console.error("Unable to validate coupon code", error);
      setCouponDetails(null);
      setCouponCode(null);
      setCouponError("Unable to check the coupon code right now.");
      setCouponSuccess(null);
    } finally {
      setIsApplyingCoupon(false);
    }
  };

  const clearCouponCode = () => {
    setCouponCode(null);
    setCouponDetails(null);
    setCouponError(null);
    setCouponSuccess("Coupon removed.");
  };

  const clearCouponMessage = () => {
    setCouponError(null);
    setCouponSuccess(null);
  };

  const value = {
    items,
    isCartOpen,
    isHydrated,
    referralCode,
    referralDetails,
    referralError,
    referralSuccess,
    referralMinimumOrder,
    referralStatusText,
    referralNeedsMoreToQualify,
    referralDiscountApplied,
    couponCode,
    couponDetails,
    couponDiscountAmount,
    couponError,
    couponSuccess,
    isApplyingReferral,
    isApplyingCoupon,
    isSignedIn,
    pointsBalance,
    pointsToEarn,
    pointsToRedeem,
    pointsRedeemedDiscount,
    setPointsToRedeem,
    itemCount,
    subtotal,
    shipping,
    taxAmount,
    salesTaxConfig,
    membershipTiers,
    memberDiscountPercent,
    shippingConfig,
    bundleConfig,
    shippingProtectionEnabled,
    setShippingProtectionEnabled,
    shippingProtectionFee,
    discountAmount,
    appliedDiscountLabel,
    autoBestDiscountApplied,
    couponOutcome,
    total,
    isBuy3Get1FreeActive: bestDiscount?.type === "buy3get1",
    isBuy3Get1FreeEligible,
    buy3Get1UntilNextFree,
    bulkSavingsApplied,
    bulkSavingsTierReached,
    ambassadorDiscountApplied,
    ambassadorDiscountPercent,
    memberFreeShipping,
    storeCreditApplied,
    storeCreditBalanceCents,
    storeCreditMinOrderCents,
    bulkSavingsPercent: bulkSavingsResult.percent,
    bulkSavingsProgress,
    totalQuantity,
    addToCart,
    updateQuantity,
    removeFromCart,
    restoreItems,
    clearCart,
    openCart,
    closeCart,
    toggleCart,
    applyReferralCode,
    clearReferralCode,
    clearReferralMessage,
    applyCouponCode,
    clearCouponCode,
    clearCouponMessage,
    setKnownEmail,
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error("useCart must be used within a CartProvider");
  }
  return context;
}

export function getShippingProgress(subtotal: number, freeShippingThreshold: number = DEFAULT_SHIPPING_CONFIG.freeShippingThreshold) {
  const isEligibleForFreeShipping = subtotal >= freeShippingThreshold;
  const amountToFreeShipping = Math.max(0, freeShippingThreshold - subtotal);
  const progressPercentage = Math.min((subtotal / freeShippingThreshold) * 100, 100);

  return {
    isEligibleForFreeShipping,
    amountToFreeShipping,
    progressPercentage,
  };
}

export function formatCartCurrency(value: number) {
  return formatCurrency(value);
}
