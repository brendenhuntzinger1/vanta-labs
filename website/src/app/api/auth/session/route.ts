import { NextResponse } from "next/server";
import { buildAuthCookieValue, buildExpiredAuthCookie } from "@/lib/auth-session";
import { createServerClient } from "@/lib/supabase-server";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const accessToken = typeof body?.accessToken === "string" ? body.accessToken : "";

    if (!accessToken) {
      return NextResponse.json({ success: false, error: "Missing access token" }, { status: 400 });
    }

    const supabaseAuthClient = createServerClient();
    const { data, error } = await supabaseAuthClient.auth.getUser(accessToken);

    if (error || !data.user) {
      return NextResponse.json({ success: false, error: "Invalid session token" }, { status: 401 });
    }

    const response = NextResponse.json({
      success: true,
      user: {
        id: data.user.id,
        email: data.user.email,
        role: data.user.app_metadata?.role ?? data.user.user_metadata?.role ?? "unknown",
      },
    });

    const authCookie = buildAuthCookieValue(accessToken);
    response.cookies.set(authCookie.name, authCookie.value, authCookie.options);

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to set session";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ success: true });
  const expired = buildExpiredAuthCookie();
  response.cookies.set(expired.name, expired.value, expired.options);
  return response;
}
