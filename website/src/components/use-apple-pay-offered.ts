"use client";

import { useSyncExternalStore } from "react";
import {
  EXPRESS_CHECKOUT_ENABLED,
  canOfferApplePay,
} from "@/lib/express-checkout";

/** PassKit API version. The constructor THROWS InvalidAccessError on any device
 *  that doesn't support it, so this is gated on supportsVersion() rather than
 *  assumed. */
export const APPLE_PAY_VERSION = 6;

// Read structurally rather than via `declare global`: the button file declares
// a richer ApplePaySession type for constructing the sheet, and two global
// declarations of the same property must agree. This only needs the two
// capability probes.
interface ApplePaySessionProbe {
  supportsVersion?: (version: number) => boolean;
  canMakePayments?: () => boolean;
}

// Platform support never changes within a page load, so there is nothing to
// subscribe to — useSyncExternalStore is here only to read a browser fact
// without a server/client hydration mismatch.
const subscribeNever = () => () => {};
const getServerSnapshot = () => false;

const getSnapshot = () => {
  const session = (window as unknown as { ApplePaySession?: ApplePaySessionProbe }).ApplePaySession;
  return canOfferApplePay({
    enabled: EXPRESS_CHECKOUT_ENABLED,
    userAgent: window.navigator.userAgent,
    hostname: window.location.hostname,
    hasApplePaySession: typeof session !== "undefined",
    supportsVersion:
      typeof session?.supportsVersion === "function" &&
      session.supportsVersion(APPLE_PAY_VERSION),
    canMakePayments:
      typeof session?.canMakePayments === "function" && session.canMakePayments(),
  });
};

/**
 * Whether Apple Pay may be offered on this page load — the single gate shared
 * by the express BUTTON and the accepted-methods PILL under the checkout CTA.
 *
 * The two used to be gated differently: the pill on EXPRESS_CHECKOUT_ENABLED
 * alone, the button on that plus platform, wallet and registered-host checks.
 * So the store advertised Apple Pay on desktop Chrome, and — the case that
 * actually costs a sale — to an iPhone that landed on the www host when only
 * the apex is registered with Apple. Advertising a wallet with no button is
 * worse than showing neither.
 *
 * False during SSR and resolved on the client without a cascading render.
 */
export function useApplePayOffered(): boolean {
  return useSyncExternalStore(subscribeNever, getSnapshot, getServerSnapshot);
}
