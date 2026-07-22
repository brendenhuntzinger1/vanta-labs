"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Product } from "@/lib/catalog-types";
import type { ReferralCode } from "@/lib/referral-codes";
import { validateReferralCodeClient } from "@/lib/referral-client";
import { calculateEarnedPoints, pointsToDollars } from "@/lib/points-math";
import { DEFAULT_MINIMUM_QUALIFYING_ORDER } from "@/lib/referral-config";
import { getBundleDiscountedLineTotal, getBundleDiscountedUnitPrice } from "@/lib/bundle-pricing";
import { calculateShipping, calculateHandlingFee, calculateTax, DEFAULT_SHIPPING_CONFIG, type ShippingConfig } from "@/lib/shipping";
import { calculateBulkSavingsDiscount, getBulkSavingsProgress, DEFAULT_BULK_SAVINGS_CONFIG, type BulkSavingsConfig } from "@/lib/bulk-savings";
import { resolveBestDiscount } from "@/lib/discount-resolution";

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
};

type CartContextValue = {
  items: CartItem[];
  isCartOpen: boolean;
  isHydrated: boolean;
  referralCode: string | null;
  referralDetails: ReferralCode | null;
  referralError: string | null;
  referralSuccess: string | null;
  couponCode: string | null;
  couponDetails: CouponDetails | null;
  couponDiscountAmount: number;
  couponError: string | null;
  couponSuccess: string | null;
  isSignedIn: boolean;
  pointsBalance: number;
  pointsToEarn: number;
  pointsToRedeem: number;
  pointsRedeemedDiscount: number;
  setPointsToRedeem: (points: number) => void;
  itemCount: number;
  subtotal: number;
  shipping: number;
  serviceFee: number;
  taxAmount: number;
  taxRatePercent: number;
  shippingConfig: ShippingConfig;
  discountAmount: number;
  total: number;
  isBuy3Get1FreeActive: boolean;
  isBuy3Get1FreeEligible: boolean;
  buy3Get1UntilNextFree: number;
  bulkSavingsApplied: boolean;
  bulkSavingsTierReached: boolean;
  memberFreeShipping: boolean;
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

function calculateBuy3Get1Discount(items: CartItem[]) {
  const expandedPrices: number[] = [];
  for (const item of items) {
    const discountedUnitPrice = getBundleDiscountedUnitPrice(item.price, item.quantity);
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

function isReferralValid(code: ReferralCode) {
  return code.customerDiscountPercent === 10 && Boolean(code.ambassadorId);
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
  const [taxRatePercent, setTaxRatePercent] = useState(0);
  const [shippingConfig, setShippingConfig] = useState<ShippingConfig>(DEFAULT_SHIPPING_CONFIG);
  const [isEligibleForBulkSavings, setIsEligibleForBulkSavings] = useState(false);
  const [bulkSavingsConfig, setBulkSavingsConfig] = useState<BulkSavingsConfig>(DEFAULT_BULK_SAVINGS_CONFIG);
  const [knownEmail, setKnownEmail] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [cartSessionId, setCartSessionId] = useState<string | null>(null);
  const [memberDiscountPercent, setMemberDiscountPercent] = useState(0);
  const [memberFreeShipping, setMemberFreeShipping] = useState(false);
  const [storeCreditBalanceCents, setStoreCreditBalanceCents] = useState(0);
  const [storeCreditMinOrderCents, setStoreCreditMinOrderCents] = useState(0);
  // Non-zero only when the signed-in customer is an approved ambassador — the
  // discount they get on their own orders (mirrors the server so the displayed
  // total, which manual-pay customers actually send, is correct).
  const [ambassadorDiscountPercent, setAmbassadorDiscountPercent] = useState(0);

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
          ambassadorDiscountPercent?: number;
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
        setAmbassadorDiscountPercent(Number(result.ambassadorDiscountPercent ?? 0) || 0);
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
        const response = await fetch("/api/catalog/promotions", { cache: "no-store" });
        if (!response.ok) return;
        const result = await response.json() as { success: boolean; promoBuy3Get1Enabled?: boolean; taxRatePercent?: number; shippingConfig?: ShippingConfig };
        if (result.success) {
          setPromoBuy3Get1Enabled(Boolean(result.promoBuy3Get1Enabled));
          setTaxRatePercent(Number(result.taxRatePercent ?? 0) || 0);
          if (result.shippingConfig) setShippingConfig(result.shippingConfig);
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
            const normalized = parsed.items.map((item) => {
              const record = item as CartItem;
              const fallbackKey = record.variantId ? `${record.slug}::${record.variantId}` : record.slug;
              return {
                ...record,
                key: record.key ?? fallbackKey,
              };
            });
            setItems(normalized);
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

    let cancelled = false;

    (async () => {
      try {
        const validatedReferral = await validateReferralCodeClient(referralCode);
        if (!validatedReferral || cancelled) {
          return;
        }

        setReferralDetails({
          code: validatedReferral.referralCode,
          customerDiscountPercent: validatedReferral.discountPercent,
          ambassadorName: validatedReferral.ambassadorName,
          ambassadorId: validatedReferral.ambassadorId,
          commissionPercent: validatedReferral.commissionPercent,
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
  }, [isHydrated, referralCode, referralDetails]);

  const itemCount = useMemo(() => items.reduce((sum, item) => sum + item.quantity, 0), [items]);

  const subtotal = useMemo(
    () => items.reduce((sum, item) => sum + getBundleDiscountedLineTotal(item.price, item.quantity), 0),
    [items],
  );

  // Abandoned-cart-recovery tracking: fires a debounced snapshot whenever
  // the cart has items and an email is known (signed-in account, or typed
  // into the checkout email field via setKnownEmail). Fire-and-forget -
  // failures here must never affect the shopping experience.
  useEffect(() => {
    if (!cartSessionId || items.length === 0 || !knownEmail.trim() || !/^\S+@\S+\.\S+$/.test(knownEmail)) {
      return;
    }

    const timeout = setTimeout(() => {
      fetch("/api/cart/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: cartSessionId,
          email: knownEmail,
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
  }, [cartSessionId, items, knownEmail, customerName, subtotal]);

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
    () => (promoBuy3Get1Enabled ? calculateBuy3Get1Discount(items) : 0),
    [items, promoBuy3Get1Enabled],
  );

  // Reaching a bulk-savings tier grants free shipping on the server
  // (payment-service.ts) regardless of which discount ultimately wins, so the
  // client preview must mirror that or the server total diverges and trips the
  // "Altered total detected" guard (notably for international bulk-eligible
  // orders). This is a distinct check from bulkSavingsApplied below (which is
  // about which discount wins the "greatest savings" contest).
  const bulkSavingsTierReached = useMemo(
    () => calculateBulkSavingsDiscount(subtotal, isEligibleForBulkSavings, bulkSavingsConfig).tier != null,
    [subtotal, isEligibleForBulkSavings, bulkSavingsConfig],
  );

  // Estimate only - no shipping address is known yet in the cart, so this
  // assumes domestic. checkout/page.tsx recomputes this from the shared
  // shipping.ts formula once the customer enters their country, and that
  // recomputed value (not this one) is what's sent to the server.
  const shipping = (bulkSavingsTierReached || memberFreeShipping) ? 0 : calculateShipping(subtotal, undefined, shippingConfig);

  const serviceFee = calculateHandlingFee(subtotal, shippingConfig);

  const couponDiscountAmount = useMemo(
    () => (buy3Get1FreeDiscount > 0 || referralDetails ? 0 : calculateCouponDiscountAmount(subtotal, couponDetails)),
    [buy3Get1FreeDiscount, referralDetails, couponDetails, subtotal],
  );

  // Whichever of buy3get1 / referral / coupon the customer is actually
  // eligible for under the existing (unchanged) mutual-exclusivity rules
  // between those three.
  const preBulkDiscount = useMemo(() => {
    if (buy3Get1FreeDiscount > 0) {
      return { type: "buy3get1" as const, amount: buy3Get1FreeDiscount };
    }
    if (referralDetails && isReferralValid(referralDetails)) {
      return { type: "referral" as const, amount: subtotal * (referralDetails.customerDiscountPercent / 100) };
    }
    return { type: "coupon" as const, amount: couponDiscountAmount };
  }, [buy3Get1FreeDiscount, referralDetails, subtotal, couponDiscountAmount]);

  // The elite "Exclusive Buy In Bulk Savings" benefit cannot stack with
  // anything else - it competes with whatever the customer would otherwise
  // get, and the single largest discount wins (see src/lib/discount-resolution.ts).
  const bulkSavingsResult = useMemo(
    () => calculateBulkSavingsDiscount(subtotal, isEligibleForBulkSavings, bulkSavingsConfig),
    [subtotal, isEligibleForBulkSavings, bulkSavingsConfig],
  );

  const memberPricingAmount = useMemo(
    () => (memberDiscountPercent > 0 ? subtotal * (memberDiscountPercent / 100) : 0),
    [memberDiscountPercent, subtotal],
  );

  // Ambassadors' own-order discount competes as a single candidate. Gated off
  // when a referral or Buy-3-Get-1 is active, mirroring payment-service.ts so
  // the client total and the server total always agree.
  const ambassadorSelfDiscountAmount = useMemo(
    () => (ambassadorDiscountPercent > 0 && !referralDetails && buy3Get1FreeDiscount <= 0
      ? subtotal * (ambassadorDiscountPercent / 100)
      : 0),
    [ambassadorDiscountPercent, referralDetails, buy3Get1FreeDiscount, subtotal],
  );

  const bestDiscount = useMemo(
    () => resolveBestDiscount([
      { type: "bulk_savings", amount: bulkSavingsResult.amount },
      { type: "member_pricing", amount: memberPricingAmount },
      { type: "ambassador", amount: ambassadorSelfDiscountAmount },
      preBulkDiscount,
    ]),
    [bulkSavingsResult.amount, memberPricingAmount, ambassadorSelfDiscountAmount, preBulkDiscount],
  );

  const discountAmount = bestDiscount?.amount ?? 0;
  const bulkSavingsApplied = bestDiscount?.type === "bulk_savings";
  const bulkSavingsProgress = useMemo(
    () => getBulkSavingsProgress(subtotal, isEligibleForBulkSavings, bulkSavingsConfig),
    [subtotal, isEligibleForBulkSavings, bulkSavingsConfig],
  );

  const pointsToEarn = useMemo(
    () => (isSignedIn ? calculateEarnedPoints(Math.max(0, subtotal - discountAmount), pointsPerDollar, pointsMultiplier) : 0),
    [isSignedIn, subtotal, discountAmount, pointsPerDollar, pointsMultiplier],
  );

  // Sales tax on the post-discount merchandise total — mirrors the server
  // (payment-service.ts) using the same shared calculateTax.
  const taxAmount = calculateTax(Math.max(0, subtotal - discountAmount), taxRatePercent);

  const totalBeforePoints = Math.max(0, subtotal + shipping + serviceFee + taxAmount - discountAmount);

  // Membership store credit auto-applies when the merchandise subtotal meets
  // the tier's redemption minimum. Mirrors payment-service.ts exactly.
  const storeCreditApplied = useMemo(() => {
    if (referralDetails) return 0; // referral codes are exclusive of store credit
    if (storeCreditBalanceCents <= 0) return 0;
    if (Math.round(subtotal * 100) < storeCreditMinOrderCents) return 0;
    return Math.min(storeCreditBalanceCents / 100, totalBeforePoints);
  }, [referralDetails, storeCreditBalanceCents, storeCreditMinOrderCents, subtotal, totalBeforePoints]);

  const totalAfterCredit = Math.max(0, totalBeforePoints - storeCreditApplied);

  // Referral codes are exclusive of every other discount, including
  // redeemed loyalty points - mirrors the server-side rule in
  // payment-service.ts.
  const pointsRedeemedDiscount = useMemo(
    () => (referralDetails ? 0 : Math.min(pointsToDollars(pointsToRedeem), totalAfterCredit)),
    [referralDetails, pointsToRedeem, totalAfterCredit],
  );

  const total = Math.max(0, totalAfterCredit - pointsRedeemedDiscount);

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
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("vanta:cart-fly", {
          detail: {
            image: options?.imageOverride ?? product.image,
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
            variantId: options?.variantId ?? null,
            quantity,
            price: (options?.priceOverride ?? Number(product.price.replace(/[^0-9.]/g, ""))) || 0,
          },
        }),
      );
    }

    setItems((currentItems) => {
      const variantKey = options?.variantId ? `${product.slug}::${options.variantId}` : product.slug;
      const existing = currentItems.find((item) => item.key === variantKey);
      if (existing) {
        return currentItems.map((item) =>
          item.key === variantKey
            ? { ...item, quantity: item.quantity + quantity }
            : item,
        );
      }
      const parsedPrice = options?.priceOverride ?? Number(product.price.replace(/[^0-9.]/g, ""));
      return [
        ...currentItems,
        {
          key: variantKey,
          variantId: options?.variantId,
          doseLabel: options?.doseLabel,
          sku: options?.sku,
          slug: product.slug,
          name: product.name,
          price: Number.isFinite(parsedPrice) ? parsedPrice : 0,
          quantity,
          batchNumber: options?.batchNumberOverride ?? product.batchNumber,
          image: options?.imageOverride ?? product.image,
          stockStatus: options?.stockStatusOverride ?? product.stockStatus,
        },
      ];
    });
    setReferralError(null);
    setReferralSuccess(null);
    // Open the cart so the shopper gets immediate, unmistakable confirmation
    // that the item was added (and a nudge toward checkout).
    setIsCartOpen(true);
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
      return currentItems.map((item) => (item.key === slug ? { ...item, quantity } : item));
    });
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

  const applyReferralCode = async (code: string) => {
    const normalized = code.trim().toUpperCase();

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

    if (subtotal < DEFAULT_MINIMUM_QUALIFYING_ORDER) {
      setReferralDetails(null);
      setReferralCode(null);
      setReferralError(`Referral codes require a minimum order of ${formatCurrency(DEFAULT_MINIMUM_QUALIFYING_ORDER)}. Add more items to use one.`);
      setReferralSuccess(null);
      return;
    }

    try {
      const validatedReferral = await validateReferralCodeClient(normalized);

      if (!validatedReferral) {
        setReferralDetails(null);
        setReferralCode(null);
        setReferralError("That referral code is not active.");
        setReferralSuccess(null);
        return;
      }

      const details: ReferralCode = {
        code: validatedReferral.referralCode,
        customerDiscountPercent: validatedReferral.discountPercent,
        ambassadorName: validatedReferral.ambassadorName,
        ambassadorId: validatedReferral.ambassadorId,
        commissionPercent: validatedReferral.commissionPercent,
      };

      setReferralDetails(details);
      setReferralCode(validatedReferral.referralCode);
      setReferralError(null);
      setReferralSuccess("Referral code applied — 10% off.");
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
    couponCode,
    couponDetails,
    couponDiscountAmount,
    couponError,
    couponSuccess,
    isSignedIn,
    pointsBalance,
    pointsToEarn,
    pointsToRedeem,
    pointsRedeemedDiscount,
    setPointsToRedeem,
    itemCount,
    subtotal,
    shipping,
    serviceFee,
    taxAmount,
    taxRatePercent,
    shippingConfig,
    discountAmount,
    total,
    isBuy3Get1FreeActive: bestDiscount?.type === "buy3get1",
    isBuy3Get1FreeEligible,
    buy3Get1UntilNextFree,
    bulkSavingsApplied,
    bulkSavingsTierReached,
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
