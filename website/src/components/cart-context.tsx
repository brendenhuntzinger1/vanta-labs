"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Product } from "@/lib/catalog-types";
import type { ReferralCode } from "@/lib/referral-codes";
import { validateReferralCodeClient } from "@/lib/referral-client";
import { calculateEarnedPoints, pointsToDollars } from "@/lib/points-math";

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
  discountAmount: number;
  total: number;
  isBuy3Get1FreeActive: boolean;
  isBuy3Get1FreeEligible: boolean;
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
};

const CartContext = createContext<CartContextValue | undefined>(undefined);

const CART_STORAGE_KEY = "vanta-labs-cart";
const REFERRAL_COOKIE_KEY = "vl_referral_code";
const FREE_SHIPPING_THRESHOLD = 250;
const FLAT_SHIPPING_FEE = 15;

function calculateBuy3Get1Discount(items: CartItem[]) {
  const expandedPrices: number[] = [];
  for (const item of items) {
    for (let i = 0; i < item.quantity; i += 1) {
      expandedPrices.push(item.price);
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

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/account/me", { cache: "no-store" });
        if (!response.ok) return;
        const result = await response.json() as {
          success: boolean;
          pointsBalance?: number;
          pointsPerDollar?: number;
          pointsMultiplier?: number;
        };
        if (!result.success) return;
        setIsSignedIn(true);
        setPointsBalance(result.pointsBalance ?? 0);
        setPointsPerDollar(result.pointsPerDollar ?? 0);
        setPointsMultiplier(result.pointsMultiplier ?? 1);
      } catch {
        // Guest shoppers simply see no points UI.
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
    () => items.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [items],
  );

  const totalQuantity = useMemo(() => items.reduce((sum, item) => sum + item.quantity, 0), [items]);
  const isBuy3Get1FreeEligible = useMemo(() => totalQuantity >= 4, [totalQuantity]);
  const buy3Get1FreeDiscount = useMemo(() => calculateBuy3Get1Discount(items), [items]);

  const shipping = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : subtotal > 0 ? FLAT_SHIPPING_FEE : 0;

  const serviceFee = 0;

  const couponDiscountAmount = useMemo(
    () => (buy3Get1FreeDiscount > 0 || referralDetails ? 0 : calculateCouponDiscountAmount(subtotal, couponDetails)),
    [buy3Get1FreeDiscount, referralDetails, couponDetails, subtotal],
  );

  const discountAmount = useMemo(() => {
    if (buy3Get1FreeDiscount > 0) {
      return buy3Get1FreeDiscount;
    }
    if (referralDetails && isReferralValid(referralDetails)) {
      return subtotal * (referralDetails.customerDiscountPercent / 100);
    }
    return couponDiscountAmount;
  }, [buy3Get1FreeDiscount, referralDetails, subtotal, couponDiscountAmount]);

  const pointsToEarn = useMemo(
    () => (isSignedIn ? calculateEarnedPoints(Math.max(0, subtotal - discountAmount), pointsPerDollar, pointsMultiplier) : 0),
    [isSignedIn, subtotal, discountAmount, pointsPerDollar, pointsMultiplier],
  );

  const totalBeforePoints = Math.max(0, subtotal + shipping + serviceFee - discountAmount);

  const pointsRedeemedDiscount = useMemo(
    () => Math.min(pointsToDollars(pointsToRedeem), totalBeforePoints),
    [pointsToRedeem, totalBeforePoints],
  );

  const total = Math.max(0, totalBeforePoints - pointsRedeemedDiscount);

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
      if (quantity <= 0) {
        return currentItems.filter((item) => item.key !== slug && item.slug !== slug);
      }
      return currentItems.map((item) => (item.key === slug || item.slug === slug ? { ...item, quantity } : item));
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

    setItems((currentItems) => currentItems.filter((item) => item.key !== slug && item.slug !== slug));
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
    discountAmount,
    total,
    isBuy3Get1FreeActive: buy3Get1FreeDiscount > 0,
    isBuy3Get1FreeEligible,
    totalQuantity,
    addToCart,
    updateQuantity,
    removeFromCart,
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

export function getShippingProgress(subtotal: number) {
  const isEligibleForFreeShipping = subtotal >= FREE_SHIPPING_THRESHOLD;
  const amountToFreeShipping = Math.max(0, FREE_SHIPPING_THRESHOLD - subtotal);
  const progressPercentage = Math.min((subtotal / FREE_SHIPPING_THRESHOLD) * 100, 100);

  return {
    isEligibleForFreeShipping,
    amountToFreeShipping,
    progressPercentage,
  };
}

export function formatCartCurrency(value: number) {
  return formatCurrency(value);
}
