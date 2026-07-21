import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { setCustomerPhone } from "@/lib/customer-account";

// Accepts digits with common separators (+, -, spaces, parentheses). We keep
// the customer's formatting but require 7-15 actual digits (ITU E.164 caps a
// full international number at 15 digits). An empty value clears the number.
export async function PATCH(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as { phone?: string };
    const raw = String(body.phone ?? "").trim().slice(0, 40);

    if (raw === "") {
      await setCustomerPhone(user.id, "");
      return NextResponse.json({ success: true });
    }

    if (!/^[+\d().\-\s]+$/.test(raw)) {
      return NextResponse.json({ success: false, error: "Enter a valid phone number." }, { status: 400 });
    }

    const digits = raw.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) {
      return NextResponse.json({ success: false, error: "Enter a valid phone number." }, { status: 400 });
    }

    await setCustomerPhone(user.id, raw);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save phone number";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
