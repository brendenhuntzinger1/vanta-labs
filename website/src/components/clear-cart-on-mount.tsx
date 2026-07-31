"use client";

import { useEffect } from "react";
import { useCart } from "@/components/cart-context";

// Mounted on the order-confirmation page. Clears the cart AFTER a completed
// order rather than before the redirect — so a cancelled/abandoned hosted
// payment keeps the cart intact, but a real confirmation empties it (fixes the
// "purchased items still in cart" bug on the card flow). Runs once on mount.
export function ClearCartOnMount() {
  const { clearCart } = useCart();
  useEffect(() => {
    clearCart();
    // clearCart is stable (defined once in the provider); run exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
