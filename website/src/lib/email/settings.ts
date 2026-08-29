import "server-only";

import { getControlSnapshot } from "@/lib/admin-control";

// -------------------------------------------------------------------------
// Email delivery settings.
//
// Resolves the live email configuration by layering the admin-editable
// "email" control snapshot OVER environment variables. This lets a
// non-technical operator turn email on and paste in SMTP or Resend
// credentials from the admin dashboard (/admin/settings) without touching
// code or env files.
//
// DISABLED BY DEFAULT: until `enabled` is turned on (and the chosen
// provider's credentials are present), getEmailProvider() returns the no-op
// provider, so nothing is sent and no action that triggers an email ever
// fails. Once enabled + configured, transactional email (order confirmation,
// payment received, payment approved/rejected, shipping updates, password
// resets, ambassador notifications, etc.) flows through the same sendEmail()
// and starts delivering automatically.
//
// ONE EMAIL IS NOT SENT FROM HERE, AND IT MATTERS (audit E1).
//
// The SIGNUP CONFIRMATION email is sent by SUPABASE AUTH, using the SMTP
// settings and templates configured in the Supabase dashboard -- not by this
// provider and not from the `from` address below. `supabase.auth.signUp()` and
// `supabase.auth.resend({ type: "signup" })` are the only things that trigger
// it, and neither passes through sendEmail(). The admin API cannot be used to
// take it over either: `generateLink({ type: "signup" })` requires the user's
// password, which we do not hold for an existing unconfirmed account.
//
// Consequences an operator has to know about, because none of them are visible
// from this dashboard:
//
//   * turning email on here does NOT turn on signup confirmation, and turning
//     it off does not turn confirmation off;
//   * a confirmation that bounces does not reach /api/webhooks/email, so it
//     appears in no suppression list and no alert. The cron sweep's
//     `signup_confirmation_watch` job (lib/auth-health.ts) exists precisely to
//     notice that absence, and is the only thing that will;
//   * the sending domain in the Supabase dashboard has its own reputation,
//     separate from the one below.
//
// This header previously claimed confirmation flowed through sendEmail() too.
// It never has. Password reset DID have the same gap and no longer does -- it
// is minted with the admin API and sent through sendEmail() by
// /api/auth/password-reset.
// -------------------------------------------------------------------------

export type EmailProviderName = "smtp" | "resend" | "sendgrid";

export interface EmailRuntimeConfig {
  enabled: boolean;
  provider: EmailProviderName;
  from: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
  };
  resend: {
    apiKey: string;
  };
  sendgrid: {
    apiKey: string;
  };
  /**
   * Physical postal address printed in the footer of every MARKETING email.
   *
   * Required by CAN-SPAM for commercial mail — a promotional message without a
   * valid physical address is non-compliant regardless of how good the opt-out
   * is. Transactional mail (receipts, shipping, password resets) is carved out
   * and does not need it, which is why this lives here rather than being forced
   * into the shared layout.
   *
   * Empty by default and deliberately NOT given a fake placeholder: the
   * campaign sender refuses to send while it is blank, which is the only
   * failure mode that can't quietly ship non-compliant mail.
   */
  marketingPostalAddress: string;
  /**
   * Optional separate From address for MARKETING mail only.
   *
   * Sending reputation is per-domain. A campaign that draws spam complaints
   * damages the reputation of whatever domain sent it — and if that is the same
   * domain as the receipts, the order confirmations and password resets start
   * landing in spam too. Those are the emails a customer genuinely needs, and
   * the failure is invisible from this side.
   *
   * Empty means "use the transactional From", which is exactly the behaviour
   * this had before the field existed, so nothing changes until an operator
   * sets up a subdomain and fills it in.
   */
  marketingFrom: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return fallback;
}

// Full runtime config INCLUDING secrets. Server-only; never send this to the
// client. Use getEmailAdminSettings() for the dashboard (secrets masked).
export async function getEmailRuntimeConfig(): Promise<EmailRuntimeConfig> {
  let cfg: Record<string, unknown> = {};
  try {
    const snapshot = await getControlSnapshot("email");
    cfg = snapshot.email ?? {};
  } catch {
    cfg = {};
  }

  const envEnabled = String(process.env.EMAIL_ENABLED ?? "").toLowerCase() === "true";
  const providerRaw = (str(cfg.provider) || process.env.EMAIL_PROVIDER || "smtp").toLowerCase();
  const provider: EmailProviderName = providerRaw === "resend" ? "resend" : providerRaw === "sendgrid" ? "sendgrid" : "smtp";

  return {
    // Off unless explicitly enabled in admin (or via EMAIL_ENABLED=true).
    enabled: bool(cfg.enabled, envEnabled),
    provider,
    from: str(cfg.from) || process.env.EMAIL_FROM || process.env.SMTP_FROM || "",
    smtp: {
      host: str(cfg.smtp_host) || process.env.SMTP_HOST || "",
      port: Number(cfg.smtp_port ?? process.env.SMTP_PORT ?? 587) || 587,
      secure: bool(cfg.smtp_secure, String(process.env.SMTP_SECURE ?? "false").toLowerCase() === "true"),
      user: str(cfg.smtp_user) || process.env.SMTP_USER || "",
      password: str(cfg.smtp_password) || process.env.SMTP_PASSWORD || "",
    },
    resend: {
      apiKey: str(cfg.resend_api_key) || process.env.RESEND_API_KEY || "",
    },
    sendgrid: {
      apiKey: str(cfg.sendgrid_api_key) || process.env.SENDGRID_API_KEY || "",
    },
    marketingPostalAddress: str(cfg.marketing_postal_address) || process.env.MARKETING_POSTAL_ADDRESS || "",
    marketingFrom: str(cfg.marketing_from) || process.env.MARKETING_EMAIL_FROM || "",
  };
}

/**
 * The From address marketing mail should use: the dedicated one when an
 * operator has configured it, otherwise the transactional one. Exported so the
 * rule lives in one place rather than being re-derived at each send site.
 */
export function resolveMarketingFrom(config: EmailRuntimeConfig): string {
  return config.marketingFrom.trim() || config.from;
}

export interface EmailAdminSettings {
  enabled: boolean;
  provider: EmailProviderName;
  from: string;
  smtp: { host: string; port: number; secure: boolean; user: string; passwordSet: boolean };
  resend: { apiKeySet: boolean };
  sendgrid: { apiKeySet: boolean };
  /** True when the selected provider has everything it needs to send. */
  ready: boolean;
  marketingPostalAddress: string;
  marketingFrom: string;
  /** The address marketing actually sends from, after the fallback. */
  effectiveMarketingFrom: string;
  /**
   * True when marketing campaigns may be sent: delivery is ready AND the
   * CAN-SPAM postal address is set. Separate from `ready` because transactional
   * mail is unaffected by the address being blank.
   */
  marketingReady: boolean;
  /**
   * True when campaigns are going out from the SAME address as receipts and
   * password resets, because no separate marketing From has been set.
   *
   * Not an error -- it is the default, and it sends perfectly well. It is a
   * standing deliverability risk that is invisible until it has already
   * happened: spam complaints from a campaign land on the domain's reputation,
   * and the first mail to suffer is the mail customers actually need. Surfaced
   * so it is a decision rather than an oversight (audit E5).
   */
  marketingSharesTransactionalDomain: boolean;
}

function isReady(config: EmailRuntimeConfig): boolean {
  if (!config.from) return false;
  if (config.provider === "smtp") return Boolean(config.smtp.host && config.smtp.user && config.smtp.password);
  if (config.provider === "resend") return Boolean(config.resend.apiKey);
  if (config.provider === "sendgrid") return Boolean(config.sendgrid.apiKey);
  return false;
}

// Masked view for the admin dashboard — secrets are reported as set/not-set,
// never returned in plaintext.
export async function getEmailAdminSettings(): Promise<EmailAdminSettings> {
  const config = await getEmailRuntimeConfig();
  return {
    enabled: config.enabled,
    provider: config.provider,
    from: config.from,
    smtp: {
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      user: config.smtp.user,
      passwordSet: Boolean(config.smtp.password),
    },
    resend: { apiKeySet: Boolean(config.resend.apiKey) },
    sendgrid: { apiKeySet: Boolean(config.sendgrid.apiKey) },
    ready: isReady(config),
    marketingPostalAddress: config.marketingPostalAddress,
    marketingFrom: config.marketingFrom,
    effectiveMarketingFrom: resolveMarketingFrom(config),
    marketingReady: config.enabled && isReady(config) && Boolean(config.marketingPostalAddress.trim()),
    // Only worth flagging once there is actually a From to share.
    marketingSharesTransactionalDomain: Boolean(config.from.trim()) && !config.marketingFrom.trim(),
  };
}

/** Why a campaign can't be sent yet, or null when it can. */
export function marketingBlockedReason(config: EmailRuntimeConfig): string | null {
  if (!config.enabled) return "Email sending is turned off in Settings.";
  if (!isReady(config)) return "The email provider isn't fully configured in Settings.";
  if (!config.marketingPostalAddress.trim()) {
    return "A physical postal address is required in Settings before marketing email can be sent (CAN-SPAM).";
  }
  return null;
}

export function emailConfigIsReady(config: EmailRuntimeConfig): boolean {
  return config.enabled && isReady(config);
}
