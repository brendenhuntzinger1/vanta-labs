import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageSettings } from "@/lib/admin-roles";
import { upsertControlValue } from "@/lib/admin-control";
import { getEmailAdminSettings } from "@/lib/email/settings";
import { getPaymentProcessorAdminSettings } from "@/lib/payment-processor-config";
import { getFulfillmentAdminSettings } from "@/lib/fulfillment/config";
import { sendEmail } from "@/lib/email/send";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

function forbiddenResponse() {
  return NextResponse.json({ success: false, error: "Your role does not have permission to change settings." }, { status: 403 });
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorizedResponse();
  if (!canManageSettings(session.role)) return forbiddenResponse();

  const [email, processor, fulfillment] = await Promise.all([
    getEmailAdminSettings(),
    getPaymentProcessorAdminSettings(),
    getFulfillmentAdminSettings(),
  ]);
  return NextResponse.json({ success: true, email, processor, fulfillment });
}

// Saves email + payment-processor settings. Secrets (SMTP password, Resend
// API key, processor secret/webhook keys) are only written when a non-empty
// value is supplied, so leaving a masked field blank keeps the stored value.
export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorizedResponse();
  if (!canManageSettings(session.role)) return forbiddenResponse();

  const ipAddress = getRequestIpAddress(request);
  const userAgent = getRequestUserAgent(request);
  const meta = { actorUsername: session.username, ipAddress, userAgent };

  try {
    const body = (await request.json()) as {
      email?: Record<string, unknown>;
      processor?: Record<string, unknown>;
      fulfillment?: Record<string, unknown>;
    };

    const set = async (section: string, key: string, value: unknown) => {
      await upsertControlValue({ section, key, value, ...meta });
    };

    const setIfPresent = async (section: string, key: string, value: unknown) => {
      // Only write secrets when the operator typed a new value (non-empty).
      if (typeof value === "string" && value.trim() === "") return;
      if (value === undefined || value === null) return;
      await set(section, key, value);
    };

    if (body.email) {
      const e = body.email;
      if (typeof e.enabled === "boolean") await set("email", "enabled", e.enabled);
      if (typeof e.provider === "string") await set("email", "provider", e.provider);
      if (typeof e.from === "string") await set("email", "from", e.from);
      if (typeof e.smtp_host === "string") await set("email", "smtp_host", e.smtp_host);
      if (e.smtp_port !== undefined) await set("email", "smtp_port", Number(e.smtp_port) || 587);
      if (typeof e.smtp_secure === "boolean") await set("email", "smtp_secure", e.smtp_secure);
      if (typeof e.smtp_user === "string") await set("email", "smtp_user", e.smtp_user);
      await setIfPresent("email", "smtp_password", e.smtp_password);
      await setIfPresent("email", "resend_api_key", e.resend_api_key);
    }

    if (body.processor) {
      const p = body.processor;
      if (typeof p.enabled === "boolean") await set("payment_processor", "enabled", p.enabled);
      if (typeof p.provider === "string") await set("payment_processor", "provider", p.provider);
      if (typeof p.display_name === "string") await set("payment_processor", "display_name", p.display_name);
      if (typeof p.publishable_key === "string") await set("payment_processor", "publishable_key", p.publishable_key);
      await setIfPresent("payment_processor", "secret_key", p.secret_key);
      await setIfPresent("payment_processor", "webhook_secret", p.webhook_secret);
    }

    if (body.fulfillment) {
      const f = body.fulfillment;
      if (typeof f.enabled === "boolean") await set("fulfillment", "enabled", f.enabled);
      if (typeof f.auto_transmit === "boolean") await set("fulfillment", "auto_transmit", f.auto_transmit);
      if (typeof f.mode === "string") await set("fulfillment", "mode", f.mode);
      if (typeof f.provider_name === "string") await set("fulfillment", "provider_name", f.provider_name);
      if (typeof f.api_base_url === "string") await set("fulfillment", "api_base_url", f.api_base_url);
      await setIfPresent("fulfillment", "api_key", f.api_key);
      await setIfPresent("fulfillment", "webhook_secret", f.webhook_secret);
      if (typeof f.payout_model === "string") await set("fulfillment", "payout_model", f.payout_model);
      if (f.payout_rate !== undefined) await set("fulfillment", "payout_rate", Number(f.payout_rate) || 0);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save settings";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

// Send a test email to verify the configured provider actually delivers.
export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorizedResponse();
  if (!canManageSettings(session.role)) return forbiddenResponse();

  try {
    const body = (await request.json()) as { to?: string };
    const to = String(body.to ?? "").trim();
    if (!to || !to.includes("@")) {
      return NextResponse.json({ success: false, error: "Enter a valid email address to send the test to." }, { status: 400 });
    }

    const result = await sendEmail({
      to,
      subject: "Vanta Labs — test email",
      html: "<p>This is a test email from your Vanta Labs admin dashboard. If you received it, transactional email is configured correctly.</p>",
      text: "This is a test email from your Vanta Labs admin dashboard. If you received it, transactional email is configured correctly.",
    });

    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error ?? "Email not sent. Check your settings and that email is enabled." }, { status: 400 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send test email";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
