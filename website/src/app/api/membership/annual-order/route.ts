import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { createAnnualMembershipManualOrder } from "@/lib/membership-billing";
import { getPaymentMethodsConfig } from "@/lib/admin-control";
import { getPaymentMethodById, isManualPaymentMethod } from "@/lib/payment-methods";

// Starts a ONE-TIME annual membership purchase paid via a manual method
// (Cash App / Zelle / PayPal). Returns the order number so the customer can
// pay + submit proof through the same manual-payment panel as products. On
// admin approval, the membership + perks activate automatically.
export async function POST(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    return NextResponse.json({ success: false, error: "Please sign in to your account first." }, { status: 401 });
  }

  try {
    const body = (await request.json()) as { tierId?: string; paymentMethod?: string };
    const tierId = String(body.tierId ?? "");
    const paymentMethod = String(body.paymentMethod ?? "");

    if (!tierId) {
      return NextResponse.json({ success: false, error: "Missing membership tier." }, { status: 400 });
    }

    // Only manual (no-fee) methods are valid for a one-time annual payment.
    const methods = await getPaymentMethodsConfig();
    const method = getPaymentMethodById(methods, paymentMethod);
    if (!method || !method.enabled || !isManualPaymentMethod(method)) {
      return NextResponse.json({ success: false, error: "Choose Cash App, Zelle, or PayPal for the annual plan." }, { status: 400 });
    }

    const result = await createAnnualMembershipManualOrder({ userId: user.id, tierId, paymentMethod });
    return NextResponse.json({ success: true, ...result, paymentMethod });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start your membership.";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
