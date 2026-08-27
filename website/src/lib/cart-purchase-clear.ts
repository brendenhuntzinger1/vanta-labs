/**
 * When a just-purchased cart may safely be emptied.
 *
 * THE ORDERING PROBLEM THIS ENCODES.
 *
 * CartProvider restores the cart from localStorage inside an effect, and only
 * once that finishes does it flip `isHydrated` and allow the persistence effect
 * to write anything back. ClearCartOnMount lives INSIDE that provider, so React
 * runs the child's effect first: a clear on bare mount emptied React state a
 * tick BEFORE hydration read storage and put the items straight back — and,
 * because persistence is gated on `isHydrated`, that clear never reached
 * storage either. The cart survived the purchase twice over.
 *
 * Waiting for `isHydrated` puts the clear on top of the restore instead of
 * underneath it, and lets the (now unblocked) persistence effect write the
 * empty cart to storage, which is what makes a refresh stay empty.
 *
 * `alreadyCleared` keeps it to exactly one clear per mount. Without it, a
 * shopper who lands on the confirmation page and then adds something new —
 * their own tab, or a cross-tab `storage` event mirroring another tab's add —
 * would have that fresh cart wiped on the next render.
 *
 * Deliberately pure and free of React so the rule can be tested directly; the
 * component below it is then a thin wrapper with nothing left to get wrong.
 */
export function shouldClearPurchasedCart(state: {
  /** True once CartProvider has finished restoring from localStorage. */
  isHydrated: boolean;
  /** True once this mount has already performed its one clear. */
  alreadyCleared: boolean;
}): boolean {
  return state.isHydrated && !state.alreadyCleared;
}
