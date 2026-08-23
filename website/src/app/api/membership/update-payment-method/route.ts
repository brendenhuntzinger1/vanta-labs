import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { updatePaymentMethod } from "@/lib/membership-billing";
import { customerSafeMessage } from "@/lib/safe-error";

// paymentMethodRef is an opaque token from the processor's own card form —
// this route never sees or stores raw card data.
//
// NO IN-APP CALLER TODAY. Card capture for SIGNUP is fully wired through
// Veyra (card-config -> hosted card form -> subscribe), but there is no
// "replace my card" screen for an EXISTING member, so nothing posts here.
//
// That matters because a past-due member is shown "Update payment method" on
// /account/subscriptions and it links to /membership — the plans page, which
// cannot update a card. A member whose card expired is trying to give the
// store money and has nowhere to do it. Reconnecting that button to a real
// card-entry step is the missing piece, not this route.
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
    return NextResponse.json({ success: false, error: customerSafeMessage(error, "Unable to update payment method") }, { status: 400 });
  }
}
