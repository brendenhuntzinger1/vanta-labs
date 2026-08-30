import { NextResponse } from "next/server";
import {
  getHomepageControlConfig,
  getSalesTaxSettings,
  getShippingConfig,
  getReferralProgramConfig,
  getCouponPolicyConfig,
  DEFAULT_REFERRAL_DISCOUNT_PERCENT,
} from "@/lib/admin-control";
import { DEFAULT_SHIPPING_CONFIG } from "@/lib/shipping";
import { DEFAULT_SALES_TAX_CONFIG } from "@/lib/sales-tax";
import { getActiveMembershipTiers } from "@/lib/membership";
import { getAmbassadorProgramSettings } from "@/lib/ambassador-settings";
import { DEFAULT_MINIMUM_QUALIFYING_ORDER } from "@/lib/referral-config";
import type { MembershipTierSummary } from "@/lib/member-pricing";
import { getApplicableBxgyPromotions } from "@/lib/bxgy-promotions";
import { serializeBxgyPromotions } from "@/lib/bxgy-config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [config, salesTaxSettings, shippingConfig, referralProgram, membershipTiers, ambassadorSettings, couponPolicy] = await Promise.all([
      getHomepageControlConfig(),
      getSalesTaxSettings(),
      getShippingConfig(),
      getReferralProgramConfig(),
      getActiveMembershipTiers().catch(() => []),
      getAmbassadorProgramSettings().catch(() => ({ minimumQualifyingOrder: DEFAULT_MINIMUM_QUALIFYING_ORDER })),
      getCouponPolicyConfig().catch(() => ({ couponsEnabled: true, allowStacking: false })),
    ]);

    // Marketing-safe tier summary for member-pricing display (product cards,
    // cart upsell, membership calculator). Paid tiers only; no internal
    // fields beyond what the public membership page already shows.
    const tierSummaries: MembershipTierSummary[] = membershipTiers
      .filter((tier) => tier.monthlyPriceCents > 0)
      .map((tier) => ({
        slug: tier.slug,
        name: tier.name,
        discountPercent: tier.memberDiscountPercent,
        monthlyPriceCents: tier.monthlyPriceCents,
        annualPriceCents: tier.annualPriceCents,
        monthlyStoreCreditCents: tier.monthlyStoreCreditCents,
        storeCreditMinOrderCents: tier.storeCreditMinOrderCents,
        freeShipping: tier.freeShipping,
        pointsPerDollar: tier.pointsPerDollar,
        introPriceCents: tier.introPriceCents,
        introDurationDays: tier.introDurationDays,
        introOfferEnabled: tier.introOfferEnabled,
      }));
    // The Buy X Get Y promotions the cart may price against: switched on,
    // inside their schedule, and not used up. The cart prices from THIS list
    // using the same engine the checkout uses, which is what keeps the preview
    // and the charge in lockstep — a promotion the server would refuse never
    // reaches the client to be previewed in the first place.
    //
    // Per-customer limits are not resolvable here (no email on a catalog read);
    // the cart asks /api/catalog/promotions/eligibility once it knows one.
    const bxgyPromotions = await getApplicableBxgyPromotions({}, { promotions: config.bxgyPromotions })
      .catch(() => []);

    return NextResponse.json({
      success: true,
      promoBuy3Get1Enabled: Boolean(config.promoBuy3Get1Enabled),
      bxgyPromotions: serializeBxgyPromotions(bxgyPromotions),
      bundleConfig: config.bundleConfig,
      bundleStacking: config.bundleStacking === true,
      // THE COUPON-STACKING POLICY, WHICH THE CART COULD NOT SEE UNTIL NOW.
      //
      // quote-order adds a coupon on top of the winning discount whenever this
      // is on; without it here the cart previewed max(promo, coupon) while the
      // card was charged promo + coupon, and refused to even accept the code
      // while a promotion was running. One policy, both sides.
      couponStackingEnabled: couponPolicy.allowStacking === true,
      // Only the tax POSTURE travels (nexus states + any per-state overrides);
      // the rate table ships with the client bundle (sales-tax.ts) so the
      // checkout preview recomputes tax instantly as the address changes.
      salesTax: {
        nexusStates: salesTaxSettings.nexusStates,
        rateOverrides: salesTaxSettings.rateOverrides,
      },
      shippingConfig,
      referralDiscountPercent: referralProgram.discountPercent,
      referralMinimumOrder: ambassadorSettings.minimumQualifyingOrder,
      // THE MASTER SWITCH, WHICH THE CLIENT COULD NOT SEE UNTIL NOW.
      //
      // quote-order.ts refuses any order still carrying a code while this is
      // off. Without it here the cart previewed and applied a discount the pay
      // button would reject — an ambassador's own link turned into a checkout
      // blocker for everyone holding it.
      referralProgramEnabled: referralProgram.enabled,
      membershipTiers: tierSummaries,
    });
  } catch (error) {
    // A promo-config read must never hard-fail a product page, and it must not
    // silently drop the tax/shipping config the client needs to build a total
    // that matches the server's authoritative charge — otherwise the preview
    // could drift from the real total and trip the anti-tamper guard during an
    // outage. Return promos OFF with the SAME defaults the server falls back
    // to (no nexus configured → no tax collected), keeping preview and charge
    // in lockstep.
    console.error("Unable to load catalog promotions", error);
    return NextResponse.json({
      success: true,
      promoBuy3Get1Enabled: false,
      // Same lockstep rule as every other field in this fallback: with the
      // config unreadable the server applies no promotion, so the client must
      // preview none either.
      bxgyPromotions: [],
      bundleConfig: null,
      // getCouponPolicyConfig's own fallback is `allowStacking: false`, so the
      // client must assume the same or the two disagree during an outage.
      couponStackingEnabled: false,
      salesTax: DEFAULT_SALES_TAX_CONFIG,
      shippingConfig: DEFAULT_SHIPPING_CONFIG,
      referralDiscountPercent: DEFAULT_REFERRAL_DISCOUNT_PERCENT,
      referralMinimumOrder: DEFAULT_MINIMUM_QUALIFYING_ORDER,
      // TRUE, matching getReferralProgramConfig's own fallback. Same lockstep
      // rule as every other field here: during an outage the client must
      // assume exactly what the server will assume, or the preview and the
      // charge disagree. Answering `false` on a failed read would also strip a
      // real discount from every referred shopper for the duration.
      referralProgramEnabled: true,
      membershipTiers: [],
    });
  }
}
