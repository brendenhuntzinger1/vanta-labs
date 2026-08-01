export const DEFAULT_DISCOUNT_PERCENT = 10 as const;
export const DEFAULT_COMMISSION_PERCENT = 15 as const;
export const DEFAULT_REFERRAL_CODE_PREFIX = "VANTA";

// Admin-configurable via src/lib/ambassador-settings.ts (falls back to
// these values). Kept here too so client components that can't import
// server-only code (cart-context.tsx) have a same-shaped default to give
// shoppers immediate feedback before the authoritative server check runs.
export const DEFAULT_MINIMUM_QUALIFYING_ORDER = 100 as const;
export const DEFAULT_MINIMUM_PAYOUT_THRESHOLD = 100 as const;
// 30-day hold (was 14) so a commission isn't auto-approved and paid out before
// the typical refund/chargeback window closes — a paid-out commission on a later
// refunded order only flips to manual_review, not an automatic clawback.
export const DEFAULT_COMMISSION_HOLD_DAYS = 30 as const;
