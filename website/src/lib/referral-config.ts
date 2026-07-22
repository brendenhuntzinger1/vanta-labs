export const DEFAULT_DISCOUNT_PERCENT = 10 as const;
export const DEFAULT_COMMISSION_PERCENT = 10 as const;
export const DEFAULT_REFERRAL_CODE_PREFIX = "VANTA";

// When an ambassador takes their payout as store credit instead of cash, the
// credit is worth this percentage of the cash amount (e.g. 125 = $125 of store
// credit for every $100 of cash commission). Admin-configurable.
export const DEFAULT_STORE_CREDIT_MULTIPLIER_PERCENT = 125 as const;

// Ambassadors get this percentage off their OWN orders as a perk. They earn no
// commission on their own orders, so this discount replaces the commission they
// would otherwise be blocked from. Admin-configurable.
export const DEFAULT_AMBASSADOR_DISCOUNT_PERCENT = 15 as const;

// Admin-configurable via src/lib/ambassador-settings.ts (falls back to
// these values). Kept here too so client components that can't import
// server-only code (cart-context.tsx) have a same-shaped default to give
// shoppers immediate feedback before the authoritative server check runs.
export const DEFAULT_MINIMUM_QUALIFYING_ORDER = 100 as const;
export const DEFAULT_MINIMUM_PAYOUT_THRESHOLD = 100 as const;
export const DEFAULT_COMMISSION_HOLD_DAYS = 14 as const;
