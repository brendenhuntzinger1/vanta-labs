import { NextResponse } from "next/server";
import { getPaymentMethodsConfig, getCardProcessingFeeConfig } from "@/lib/admin-control";
import { getEnabledPaymentMethods } from "@/lib/payment-methods";

export const dynamic = "force-dynamic";

// Public: the checkout client fetches the enabled payment methods and the
// card processing fee to render the selector and preview the fee / final
// total. The server independently recomputes the authoritative total at order
// creation, so this is display-only.
export async function GET() {
  try {
    const [methods, cardProcessingFee] = await Promise.all([
      getPaymentMethodsConfig(),
      getCardProcessingFeeConfig(),
    ]);
    return NextResponse.json({
      success: true,
      methods: getEnabledPaymentMethods(methods),
      cardProcessingFee,
    });
  } catch {
    return NextResponse.json({ success: true, methods: [], cardProcessingFee: null });
  }
}
