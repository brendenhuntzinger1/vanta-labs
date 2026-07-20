import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { updatePaymentMethod } from "@/lib/membership-billing";

// paymentMethodRef is an opaque token from whichever billing processor's
// client SDK eventually collects the card (Stripe Elements, etc.) - this
// route never sees or stores raw card data. Until a processor is
// connected there's no client SDK to produce that token yet; see
// src/components/membership-payment-method.tsx for the current
// placeholder state.
export async function POST(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null) as { paymentMethodRef?: string } | null;
  if (!body?.paymentMethodRef) {
    return NextResponse.json({ success: false, error: "Missing payment method reference" }, { status: 400 });
  }

  try {
    await updatePaymentMethod(user.id, body.paymentMethodRef);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Unable to update payment method" }, { status: 400 });
  }
}
