import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { setCustomerBirthday } from "@/lib/customer-account";

export async function PATCH(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json() as { birthday?: string };
    const birthday = String(body.birthday ?? "").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
      return NextResponse.json({ success: false, error: "Enter a valid date (YYYY-MM-DD)." }, { status: 400 });
    }

    await setCustomerBirthday(user.id, birthday);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save birthday";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
