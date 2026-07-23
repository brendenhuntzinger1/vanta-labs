import { NextResponse } from "next/server";
import { getHomepageControlConfig, getTaxRatePercent, getShippingConfig } from "@/lib/admin-control";

export const dynamic = "force-dynamic";

export async function GET() {
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
}
