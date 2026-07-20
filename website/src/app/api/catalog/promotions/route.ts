import { NextResponse } from "next/server";
import { getHomepageControlConfig } from "@/lib/admin-control";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = await getHomepageControlConfig();
  return NextResponse.json({
    success: true,
    promoBuy3Get1Enabled: Boolean(config.promoBuy3Get1Enabled),
  });
}
