"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Product } from "@/lib/demo-data";
import { demoReferralCodes, type ReferralCode } from "@/lib/referral-codes";

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
  if (code.status !== "Active") {
    return false;
  }
  const expirationDate = new Date(code.expirationDate);
  if (Number.isNaN(expirationDate.getTime())) {
    return false;
  }
  if (expirationDate < new Date()) {
    return false;
  }
  return code.uses < code.maxUses;
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [referralDetails, setReferralDetails] = useState<ReferralCode | null>(null);
  const [referralError, setReferralError] = useState<string | null>(null);
  const [referralSuccess, setReferralSuccess] = useState<string | null>(null);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(CART_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as {
          items?: CartItem[];
          referralCode?: string | null;
        };
        if (parsed.items) {
          setItems(parsed.items);
        }
        if (parsed.referralCode) {
          setReferralCode(parsed.referralCode);
          const details = demoReferralCodes.find(
            (entry) => entry.code === parsed.referralCode,
          );
          if (details) {
            setReferralDetails(details);
          }
        }
      }
    } catch (error) {
      console.error("Unable to read cart state", error);
    } finally {
      setIsHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!isHydrated) {
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

  const shipping = subtotal > 0 ? 24 : 0;
  const discountAmount = useMemo(() => {
    if (!referralDetails || !isReferralValid(referralDetails)) {
      return 0;
    }
    return subtotal * (referralDetails.customerDiscountPercent / 100);
  }, [referralDetails, subtotal]);

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

  const applyReferralCode = (code: string) => {
    const normalized = code.trim().toUpperCase();
    const details = demoReferralCodes.find((entry) => entry.code === normalized);

    if (!details) {
      setReferralDetails(null);
      setReferralCode(null);
      setReferralError("That referral code is not recognized in the demo system.");
      setReferralSuccess(null);
      return;
    }

    if (details.status !== "Active") {
      setReferralDetails(null);
      setReferralCode(null);
      setReferralError("This referral code is no longer active.");
      setReferralSuccess(null);
      return;
    }

    const expirationDate = new Date(details.expirationDate);
    if (Number.isNaN(expirationDate.getTime()) || expirationDate < new Date()) {
      setReferralDetails(null);
      setReferralCode(null);
      setReferralError("This referral code has expired.");
      setReferralSuccess(null);
      return;
    }

    if (details.uses >= details.maxUses) {
      setReferralDetails(null);
      setReferralCode(null);
      setReferralError("This referral code has reached its maximum number of uses.");
      setReferralSuccess(null);
      return;
    }

    setReferralCode(normalized);
    setReferralDetails(details);
    setReferralError(null);
    setReferralSuccess(`Applied ${normalized} for ${details.customerDiscountPercent}% off.`);
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

export function formatCartCurrency(value: number) {
  return formatCurrency(value);
}
