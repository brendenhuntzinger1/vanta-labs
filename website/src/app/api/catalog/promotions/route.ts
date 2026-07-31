import { NextResponse } from "next/server";
import {
  getHomepageControlConfig,
  getSalesTaxSettings,
  getShippingConfig,
  getReferralProgramConfig,
  DEFAULT_REFERRAL_DISCOUNT_PERCENT,
} from "@/lib/admin-control";
import { DEFAULT_SHIPPING_CONFIG } from "@/lib/shipping";
import { DEFAULT_SALES_TAX_CONFIG } from "@/lib/sales-tax";
import { getActiveMembershipTiers } from "@/lib/membership";
import type { MembershipTierSummary } from "@/lib/member-pricing";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [config, salesTaxSettings, shippingConfig, referralProgram, membershipTiers] = await Promise.all([
      getHomepageControlConfig(),
      getSalesTaxSettings(),
      getShippingConfig(),
      getReferralProgramConfig(),
      getActiveMembershipTiers().catch(() => []),
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
    return NextResponse.json({
      success: true,
      promoBuy3Get1Enabled: Boolean(config.promoBuy3Get1Enabled),
      bundleConfig: config.bundleConfig,
      bundleStacking: config.bundleStacking === true,
      // Only the tax POSTURE travels (nexus states + any per-state overrides);
      // the rate table ships with the client bundle (sales-tax.ts) so the
      // checkout preview recomputes tax instantly as the address changes.
      salesTax: {
        nexusStates: salesTaxSettings.nexusStates,
        rateOverrides: salesTaxSettings.rateOverrides,
      },
      shippingConfig,
      referralDiscountPercent: referralProgram.discountPercent,
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
      bundleConfig: null,
      salesTax: DEFAULT_SALES_TAX_CONFIG,
      shippingConfig: DEFAULT_SHIPPING_CONFIG,
      referralDiscountPercent: DEFAULT_REFERRAL_DISCOUNT_PERCENT,
      membershipTiers: [],
    });
  }
}
