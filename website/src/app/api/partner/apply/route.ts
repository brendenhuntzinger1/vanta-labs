import { NextResponse } from "next/server";
import { createPartnerApplication } from "@/lib/partner-portal";
import { createServerClient } from "@/lib/supabase-server";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const accessToken = typeof body?.accessToken === "string" ? body.accessToken : "";
    const fullName = String(body?.fullName ?? "").trim();

    if (!accessToken) {
      return NextResponse.json({ success: false, error: "Missing access token" }, { status: 400 });
    }

    if (!fullName) {
      return NextResponse.json({ success: false, error: "Full name is required" }, { status: 400 });
    }

    const supabaseAuthClient = createServerClient();
    const { data, error } = await supabaseAuthClient.auth.getUser(accessToken);
    if (error || !data.user || !data.user.email) {
      return NextResponse.json({ success: false, error: "Invalid auth session" }, { status: 401 });
    }

    const result = await createPartnerApplication({
      authUserId: data.user.id,
      email: data.user.email,
      name: fullName,
    });

    return NextResponse.json({ success: true, partner: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to submit application";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
