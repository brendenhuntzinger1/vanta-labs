export const DEFAULT_DISCOUNT_PERCENT = 10 as const;
// NOTE: there is deliberately no DEFAULT_COMMISSION_PERCENT here. The one
// source of truth for the commission rate is the Control Center, read through
// admin-control's DEFAULT_AMBASSADOR_COMMISSION_PERCENT (10). A second
// constant here said 15 and disagreed with it.
export const DEFAULT_REFERRAL_CODE_PREFIX = "VANTA";

// Admin-configurable via src/lib/ambassador-settings.ts (falls back to
// these values). Kept here too so client components that can't import
// server-only code (cart-context.tsx) have a same-shaped default to give
// shoppers immediate feedback before the authoritative server check runs.
// NO MINIMUM QUALIFYING ORDER. 0 means "every referred order earns", and
// `minimumCents` in referral-qualification.ts is what turns that 0 into no gate.
//
// It was 100. Against the live order book that gate was withholding almost
// everything: eight of eleven paid orders sat under it, so an ambassador could
// send traffic that converted and still earn nothing, and the shopper who came
// through her link lost the discount too. The owner removed the minimum.
//
// This constant is the FALLBACK half of that removal, and it matters as much as
// the stored Control Center value: `getAmbassadorProgramSettings` returns it
// from its own catch, and the cart holds it as the optimistic value before the
// server answers. Left at 100, one unreadable control table would silently
// reinstate a $100 gate on live baskets with nothing logged and nobody told —
// the same silent-strip failure `resolveAmbassadorCustomerDiscount` is written
// to avoid. Pinned by referral-minimum-removal.test.ts.
export const DEFAULT_MINIMUM_QUALIFYING_ORDER = 0 as const;
export const DEFAULT_MINIMUM_PAYOUT_THRESHOLD = 100 as const;
// 30-day hold (was 14) so a commission isn't auto-approved and paid out before
// the typical refund/chargeback window closes — a paid-out commission on a later
// refunded order only flips to manual_review, not an automatic clawback.
export const DEFAULT_COMMISSION_HOLD_DAYS = 30 as const;
