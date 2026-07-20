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
// fails. Once enabled + configured, EVERY transactional email in the app
// (order confirmation, payment received, payment approved/rejected, shipping
// updates, password resets, account verification, ambassador notifications,
// etc.) flows through the same sendEmail() and starts delivering
// automatically.
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
  };
}

export interface EmailAdminSettings {
  enabled: boolean;
  provider: EmailProviderName;
  from: string;
  smtp: { host: string; port: number; secure: boolean; user: string; passwordSet: boolean };
  resend: { apiKeySet: boolean };
  /** True when the selected provider has everything it needs to send. */
  ready: boolean;
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
    ready: isReady(config),
  };
}

export function emailConfigIsReady(config: EmailRuntimeConfig): boolean {
  return config.enabled && isReady(config);
}
