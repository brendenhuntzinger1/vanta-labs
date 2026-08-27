import "server-only";

import { getReferralProgramConfig } from "@/lib/admin-control";
import { getAmbassadorProgramSettings } from "@/lib/ambassador-settings";
import {
  type PublicProgramTerms,
  formatPercent,
  formatThreshold,
  holdDuration,
  holdLabel,
} from "@/lib/public-program-terms-shared";
import {
  DEFAULT_COMMISSION_HOLD_DAYS,
  DEFAULT_MINIMUM_PAYOUT_THRESHOLD,
  DEFAULT_MINIMUM_QUALIFYING_ORDER,
  DEFAULT_DISCOUNT_PERCENT,
} from "@/lib/referral-config";

// One import for server callers; the shape and formatters themselves live in
// the shared module so Client Components can reach them too.
export type { PublicProgramTerms };
export { formatPercent, formatThreshold, holdDuration, holdLabel };

/**
 * THE PROGRAMME TERMS, AS THE PUBLIC PAGES ARE ALLOWED TO STATE THEM.
 *
 * The recruitment pages (/ambassador and /partner) make specific, numeric
 * promises: what an ambassador earns, what their audience saves, what they get
 * off their own orders, how long money is held, and the two $100 thresholds.
 * Every one of those numbers is configured in the Control Center and read by
 * the code that actually pays — but the pages typed their own copies.
 *
 * The 2026-08-27 audit found the predictable result: both pages advertised a
 * "15% Base Commission" while the programme default paid 10, because 15 is the
 * TOP tier (`commission_tier_rules`: 10 / 12.5 / 15) and somebody wrote the
 * aspiration into the page. The approval email and the partner dashboard had
 * already been moved onto the live settings after an earlier incident with the
 * hold period; the landing pages were the last copies left.
 *
 * So this is the one server-side reader both pages use. It exists as its own
 * module, rather than each page calling the two config functions, so that
 * "what the public is told" is a single named thing that can be tested and
 * cannot drift between the two pages either.
 *
 * A LANDING PAGE MUST STILL RENDER. Both config reads already swallow their own
 * failures and return defaults, but the fallback is repeated here so that a
 * future change to either one cannot turn a recruitment page into an error
 * page. Showing the built-in defaults is the correct failure mode: they are the
 * same values the payout code falls back to, so the page and the money stay in
 * agreement even when the database is unreachable.
 */
export const FALLBACK_PROGRAM_TERMS: PublicProgramTerms = {
  // Deliberately NOT a literal: admin-control owns the commission default, and
  // referral-config says in as many words that a second constant here once
  // disagreed with it. Importing the config function's own fallback is not
  // possible without importing the function, so this reads it at call time
  // below and only hard-codes the values referral-config already owns.
  commissionPercent: 10,
  customerDiscountPercent: DEFAULT_DISCOUNT_PERCENT,
  personalDiscountPercent: 20,
  commissionHoldDays: DEFAULT_COMMISSION_HOLD_DAYS,
  minimumQualifyingOrder: DEFAULT_MINIMUM_QUALIFYING_ORDER,
  minimumPayoutThreshold: DEFAULT_MINIMUM_PAYOUT_THRESHOLD,
};

export async function getPublicProgramTerms(): Promise<PublicProgramTerms> {
  const [referral, ambassador] = await Promise.all([
    getReferralProgramConfig().catch(() => null),
    getAmbassadorProgramSettings().catch(() => null),
  ]);

  return {
    commissionPercent: referral?.defaultCommissionPercent ?? FALLBACK_PROGRAM_TERMS.commissionPercent,
    customerDiscountPercent: referral?.discountPercent ?? FALLBACK_PROGRAM_TERMS.customerDiscountPercent,
    personalDiscountPercent: referral?.personalDiscountPercent ?? FALLBACK_PROGRAM_TERMS.personalDiscountPercent,
    commissionHoldDays: ambassador?.commissionHoldDays ?? FALLBACK_PROGRAM_TERMS.commissionHoldDays,
    minimumQualifyingOrder: ambassador?.minimumQualifyingOrder ?? FALLBACK_PROGRAM_TERMS.minimumQualifyingOrder,
    minimumPayoutThreshold: ambassador?.minimumPayoutThreshold ?? FALLBACK_PROGRAM_TERMS.minimumPayoutThreshold,
  };
}
