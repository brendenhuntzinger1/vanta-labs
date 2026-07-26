import { NextResponse } from "next/server";
import {
  getHomepageControlConfig,
  getTaxRatePercent,
  getShippingConfig,
  getReferralProgramConfig,
  DEFAULT_SALES_TAX_PERCENT,
  DEFAULT_REFERRAL_DISCOUNT_PERCENT,
} from "@/lib/admin-control";
import { DEFAULT_SHIPPING_CONFIG } from "@/lib/shipping";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [config, taxRatePercent, shippingConfig, referralProgram] = await Promise.all([
      getHomepageControlConfig(),
      getTaxRatePercent(),
      getShippingConfig(),
      getReferralProgramConfig(),
    ]);
    return NextResponse.json({
      success: true,
      promoBuy3Get1Enabled: Boolean(config.promoBuy3Get1Enabled),
      bundleConfig: config.bundleConfig,
      taxRatePercent,
      shippingConfig,
      referralDiscountPercent: referralProgram.discountPercent,
    });
  } catch (error) {
    // A promo-config read must never hard-fail a product page, and it must not
    // silently drop the tax/shipping config the client needs to build a total
    // that matches the server's authoritative charge — otherwise the client
    // would preview tax=0 while the server charges the default, tripping the
    // anti-tamper guard and blocking legit checkouts during an outage. Return
    // promos OFF but include the SAME defaults the server falls back to, so the
    // preview stays in lockstep with the charge.
    console.error("Unable to load catalog promotions", error);
    return NextResponse.json({
      success: true,
      promoBuy3Get1Enabled: false,
      bundleConfig: null,
      taxRatePercent: DEFAULT_SALES_TAX_PERCENT,
      shippingConfig: DEFAULT_SHIPPING_CONFIG,
      referralDiscountPercent: DEFAULT_REFERRAL_DISCOUNT_PERCENT,
    });
  }
}
