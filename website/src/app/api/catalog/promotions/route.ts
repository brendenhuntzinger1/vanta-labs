import { NextResponse } from "next/server";
import { getHomepageControlConfig, getTaxRatePercent, getShippingConfig } from "@/lib/admin-control";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [config, taxRatePercent, shippingConfig] = await Promise.all([
      getHomepageControlConfig(),
      getTaxRatePercent(),
      getShippingConfig(),
    ]);
    return NextResponse.json({
      success: true,
      promoBuy3Get1Enabled: Boolean(config.promoBuy3Get1Enabled),
      bundleConfig: config.bundleConfig,
      taxRatePercent,
      shippingConfig,
    });
  } catch (error) {
    // A promo-config read must never hard-fail a product page. Return success
    // with promos off so the storefront renders at list price.
    console.error("Unable to load catalog promotions", error);
    return NextResponse.json({ success: false, promoBuy3Get1Enabled: false, bundleConfig: null });
  }
}
