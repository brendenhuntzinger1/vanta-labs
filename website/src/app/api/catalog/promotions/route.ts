import { NextResponse } from "next/server";
import { getHomepageControlConfig, getTaxRatePercent } from "@/lib/admin-control";

export const dynamic = "force-dynamic";

export async function GET() {
  const [config, taxRatePercent] = await Promise.all([
    getHomepageControlConfig(),
    getTaxRatePercent(),
  ]);
  return NextResponse.json({
    success: true,
    promoBuy3Get1Enabled: Boolean(config.promoBuy3Get1Enabled),
    taxRatePercent,
  });
}
