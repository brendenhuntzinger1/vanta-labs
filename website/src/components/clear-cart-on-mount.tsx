"use client";

import { useEffect, useRef } from "react";
import { useCart } from "@/components/cart-context";
import { shouldClearPurchasedCart } from "@/lib/cart-purchase-clear";

// Mounted on the order-confirmation page. Clears the cart AFTER a completed
// order rather than before the redirect — so a cancelled/abandoned hosted
// payment keeps the cart intact, but a real confirmation empties it.
//
// IT MUST WAIT FOR HYDRATION. This used to clear on bare mount, and it silently
// did nothing: this component is a child of CartProvider, so its effect ran
// BEFORE the provider's hydration effect, which then restored the pre-purchase
// cart from localStorage on top of the clear. The shopper was left holding the
// items they had just paid for (reproduced: one item still in the cart, and in
// the header badge, two full seconds after the confirmation page loaded).
//
// Clearing after `isHydrated` also means the provider's persistence effect —
// which is itself gated on `isHydrated` — is finally free to write the empty
// cart to storage, so a refresh stays empty and other tabs pick it up through
// the provider's `storage` listener.
//
// See lib/cart-purchase-clear.ts for the rule and its tests.
export function ClearCartOnMount() {
  const { clearCart, isHydrated } = useCart();
  // A ref, not state: flipping it must not itself cause a render, and it has to
  // survive the re-render that clearing triggers.
  const alreadyCleared = useRef(false);

  useEffect(() => {
    if (!shouldClearPurchasedCart({ isHydrated, alreadyCleared: alreadyCleared.current })) {
      return;
    }
    alreadyCleared.current = true;
    clearCart();
  }, [isHydrated, clearCart]);

  return null;
}
