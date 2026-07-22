import { NextResponse } from "next/server";
import { getHomepageControlConfig, getTaxRatePercent, getShippingConfig } from "@/lib/admin-control";
import { getPromotionRules } from "@/lib/promotion-rules";

export const dynamic = "force-dynamic";

export async function GET() {
  const [config, taxRatePercent, shippingConfig, promotionRules] = await Promise.all([
    getHomepageControlConfig(),
    getTaxRatePercent(),
    getShippingConfig(),
    getPromotionRules(),
  ]);
  return NextResponse.json({
    success: true,
    promoBuy3Get1Enabled: Boolean(config.promoBuy3Get1Enabled),
    taxRatePercent,
    shippingConfig,
    promotionRules,
  });
}
