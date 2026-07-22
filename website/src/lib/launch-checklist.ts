import { supabaseAdmin } from "@/lib/supabase-server";
import { getEmailAdminSettings } from "@/lib/email/settings";
import { getPaymentProcessorAdminSettings } from "@/lib/payment-processor-config";
import { getFulfillmentAdminSettings } from "@/lib/fulfillment/config";

export type ChecklistStatus = "ok" | "warn" | "manual";

export interface ChecklistItem {
  key: string;
  label: string;
  status: ChecklistStatus;
  detail: string;
}

function envSet(name: string): boolean {
  return Boolean(process.env[name] && String(process.env[name]).trim());
}

// Builds the pre-launch readiness checklist. Auto-detectable items report ok
// (green) / warn (red). Items that cannot be verified from the server (SSL, DB
// backups, live auth email delivery) are reported as "manual" for a human to
// confirm and check off.
export async function getLaunchChecklist(): Promise<ChecklistItem[]> {
  const items: ChecklistItem[] = [];

  // Production domain
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim();
  const domainOk = Boolean(siteUrl) && !/localhost|127\.0\.0\.1/.test(siteUrl);
  items.push({
    key: "domain",
    label: "Production domain configured",
    status: domainOk ? "ok" : "warn",
    detail: domainOk ? siteUrl : "Set NEXT_PUBLIC_SITE_URL to your real https domain (QR codes and email links depend on it).",
  });

  // Core env vars
  const envOk = envSet("NEXT_PUBLIC_SUPABASE_URL") && envSet("SUPABASE_SERVICE_ROLE_KEY");
  items.push({
    key: "env",
    label: "Environment variables configured",
    status: envOk ? "ok" : "warn",
    detail: envOk ? "Supabase URL and service-role key are set." : "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.",
  });

  // Supabase Auth (config presence; live verification is manual)
  const authConfigured = envSet("NEXT_PUBLIC_SUPABASE_URL") && envSet("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  items.push({
    key: "auth",
    label: "Supabase Auth verified",
    status: authConfigured ? "ok" : "warn",
    detail: authConfigured ? "Supabase Auth is configured. Confirm signup/login/reset in staging." : "Missing Supabase anon key.",
  });

  // SMTP / email provider
  const email = await getEmailAdminSettings().catch(() => null);
  const emailOk = Boolean(email?.enabled && email?.from && (
    (email.provider === "smtp" && email.smtp.host && email.smtp.user && email.smtp.passwordSet) ||
    (email.provider === "resend" && email.resend.apiKeySet)
  ));
  items.push({
    key: "smtp",
    label: "SMTP / email provider connected",
    status: emailOk ? "ok" : "warn",
    detail: emailOk ? `Email provider "${email?.provider}" is configured.` : "No email provider configured — transactional emails will not send.",
  });

  // Payment processor
  const pay = await getPaymentProcessorAdminSettings().catch(() => null);
  const payOk = Boolean(pay?.secretKeySet);
  items.push({
    key: "payments",
    label: "Payment processor connected",
    status: payOk ? "ok" : "manual",
    detail: payOk ? "Payment processor credentials are set." : "Card processing needs processor credentials (manual payment methods work without it).",
  });

  // Fulfillment
  const fulfillment = await getFulfillmentAdminSettings().catch(() => null);
  const fulfillmentOk = Boolean(fulfillment?.enabled && fulfillment?.apiKeySet);
  items.push({
    key: "fulfillment",
    label: "Fulfillment API connected",
    status: fulfillmentOk ? "ok" : "manual",
    detail: fulfillmentOk ? "3PL fulfillment is enabled and credentialed." : "Enter 3PL API credentials when your provider is ready.",
  });

  // COA library populated
  let coaCount = 0;
  let batchCount = 0;
  try {
    const { count: coa } = await supabaseAdmin
      .from("products")
      .select("id", { count: "exact", head: true })
      .not("coa_url", "is", null)
      .neq("coa_url", "");
    coaCount = coa ?? 0;
    const { count: batch } = await supabaseAdmin
      .from("products")
      .select("id", { count: "exact", head: true })
      .not("batch_number", "is", null)
      .neq("batch_number", "");
    batchCount = batch ?? 0;
  } catch {
    // Leave counts at 0 on error.
  }

  items.push({
    key: "coa",
    label: "COA library populated",
    status: coaCount > 0 ? "ok" : "warn",
    detail: coaCount > 0 ? `${coaCount} product(s) have a COA document linked.` : "No products have a COA document linked yet.",
  });
  items.push({
    key: "batches",
    label: "Batch numbers verified",
    status: batchCount > 0 ? "ok" : "warn",
    detail: batchCount > 0 ? `${batchCount} product(s) have a batch number set.` : "No products have a batch number set yet.",
  });

  // Manual-only items
  items.push({
    key: "ssl",
    label: "SSL active",
    status: "manual",
    detail: "Confirm HTTPS/SSL is active on your production domain (automatic on Vercel).",
  });
  items.push({
    key: "backups",
    label: "Database backups enabled",
    status: "manual",
    detail: "Enable point-in-time recovery / scheduled backups in the Supabase dashboard.",
  });

  return items;
}
