"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Product } from "@/lib/demo-data";
import type { ReferralCode } from "@/lib/referral-codes";
import { validateReferralCodeClient } from "@/lib/referral-client";
export type CartItem = {
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
  itemCount: number;
  subtotal: number;
  shipping: number;
  discountAmount: number;
  total: number;
  isBuy3Get1FreeActive: boolean;
  isBuy3Get1FreeEligible: boolean;
  totalQuantity: number;
  addToCart: (product: Product, quantity?: number) => void;
  updateQuantity: (slug: string, quantity: number) => void;
  removeFromCart: (slug: string) => void;
  clearCart: () => void;
  openCart: () => void;
  closeCart: () => void;
  toggleCart: () => void;
  applyReferralCode: (code: string) => void;
  clearReferralCode: () => void;
  clearReferralMessage: () => void;
};

const CartContext = createContext<CartContextValue | undefined>(undefined);

const CART_STORAGE_KEY = "vanta-labs-cart";

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function isReferralValid(code: ReferralCode) {
  return code.customerDiscountPercent === 10 && Boolean(code.ambassadorId);
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isHydrated] = useState(false);
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [referralDetails, setReferralDetails] = useState<ReferralCode | null>(null);
  const [referralError, setReferralError] = useState<string | null>(null);
  const [referralSuccess, setReferralSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const loadPersistedCart = () => {
      try {
        const stored = window.localStorage.getItem(CART_STORAGE_KEY);
        if (!stored) {
          return;
        }

        const parsed = JSON.parse(stored) as {
          items?: CartItem[];
          referralCode?: string | null;
        };

        if (Array.isArray(parsed.items)) {
          setItems(parsed.items);
        }

        if (typeof parsed.referralCode === "string") {
          setReferralCode(parsed.referralCode);
        }
      } catch (error) {
        console.error("Unable to read cart state", error);
      }
    };

    loadPersistedCart();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
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

  const itemCount = useMemo(() => items.reduce((sum, item) => sum + item.quantity, 0), [items]);

  const subtotal = useMemo(
    () => items.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [items],
  );

  // Calculate buy 3 get 1 free discount (when 4+ items total)
  const totalQuantity = useMemo(() => items.reduce((sum, item) => sum + item.quantity, 0), [items]);
  const isBuy3Get1FreeEligible = useMemo(() => totalQuantity >= 3, [totalQuantity]);
  const buy3Get1FreeDiscount = useMemo(() => {
    if (totalQuantity < 3) return 0;
    // Find the cheapest item
    const cheapestItem = items.reduce((min, current) => (current.price < min.price ? current : min), items[0]);
    return cheapestItem?.price || 0;
  }, [items, totalQuantity]);

  // Shipping: $14.99 for orders under $200, free for $200+
  const shipping = subtotal >= 200 ? 0 : subtotal > 0 ? 14.99 : 0;
  
  // Discount amount: use buy 3 get 1 free if applicable, otherwise use referral code
  // These two offers are mutually exclusive
  const discountAmount = useMemo(() => {
    if (buy3Get1FreeDiscount > 0) {
      return buy3Get1FreeDiscount;
    }
    if (!referralDetails || !isReferralValid(referralDetails)) {
      return 0;
    }
    return subtotal * (referralDetails.customerDiscountPercent / 100);
  }, [buy3Get1FreeDiscount, referralDetails, subtotal]);

  const total = Math.max(0, subtotal + shipping - discountAmount);

  const addToCart = (product: Product, quantity = 1) => {
    setItems((currentItems) => {
      const existing = currentItems.find((item) => item.slug === product.slug);
      if (existing) {
        return currentItems.map((item) =>
          item.slug === product.slug
            ? { ...item, quantity: item.quantity + quantity }
            : item,
        );
      }
      const parsedPrice = Number(product.price.replace(/[^0-9.]/g, ""));
      return [
        ...currentItems,
        {
          slug: product.slug,
          name: product.name,
          price: Number.isFinite(parsedPrice) ? parsedPrice : 0,
          quantity,
          batchNumber: product.batchNumber,
          image: product.image,
          stockStatus: product.stockStatus,
        },
      ];
    });
    setIsCartOpen(true);
    setReferralError(null);
    setReferralSuccess(null);
  };

  const updateQuantity = (slug: string, quantity: number) => {
    setItems((currentItems) => {
      if (quantity <= 0) {
        return currentItems.filter((item) => item.slug !== slug);
      }
      return currentItems.map((item) => (item.slug === slug ? { ...item, quantity } : item));
    });
  };

  const removeFromCart = (slug: string) => {
    setItems((currentItems) => currentItems.filter((item) => item.slug !== slug));
  };

  const clearCart = () => {
    setItems([]);
    setReferralCode(null);
    setReferralDetails(null);
    setReferralError(null);
    setReferralSuccess(null);
  };

  const openCart = () => setIsCartOpen(true);
  const closeCart = () => setIsCartOpen(false);
  const toggleCart = () => setIsCartOpen((current) => !current);

  const applyReferralCode = async (code: string) => {
    const normalized = code.trim().toUpperCase();

    // Check if buy 3 get 1 free is active - if so, don't allow referral codes
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
  };

  const clearReferralMessage = () => {
    setReferralError(null);
    setReferralSuccess(null);
  };

  const value = {
    items,
    isCartOpen,
    isHydrated,
    referralCode,
    referralDetails,
    referralError,
    referralSuccess,
    itemCount,
    subtotal,
    shipping,
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
  const FREE_SHIPPING_THRESHOLD = 200;
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
