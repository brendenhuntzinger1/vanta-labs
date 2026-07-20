import "server-only";

import { getControlSnapshot } from "@/lib/admin-control";

// -------------------------------------------------------------------------
// Card payment processor connection settings.
//
// Admin-editable placeholders so the card processor (Stripe or another
// gateway) can be connected later from the dashboard without touching code.
// Stored in the "payment_processor" control section, layered over env
// (PAYMENT_* variables). Secrets are never returned to the client in
// plaintext - the admin view reports only whether each is set.
//
// NOTE: the card checkout path itself is still a stub until a real processor
// integration is implemented. These settings persist the connection details
// so that integration can read them; entering keys here does not by itself
// start charging cards.
// -------------------------------------------------------------------------

export interface PaymentProcessorRuntimeConfig {
  enabled: boolean;
  provider: string; // e.g. "stripe", "square", "custom"
  displayName: string;
  publishableKey: string;
  secretKey: string;
  webhookSecret: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function getPaymentProcessorRuntimeConfig(): Promise<PaymentProcessorRuntimeConfig> {
  let cfg: Record<string, unknown> = {};
  try {
    const snapshot = await getControlSnapshot("payment_processor");
    cfg = snapshot.payment_processor ?? {};
  } catch {
    cfg = {};
  }

  return {
    enabled: cfg.enabled === true,
    provider: str(cfg.provider) || process.env.PAYMENT_PROVIDER || "",
    displayName: str(cfg.display_name) || "Credit / Debit Card",
    publishableKey: str(cfg.publishable_key) || process.env.PAYMENT_PUBLIC_KEY || "",
    secretKey: str(cfg.secret_key) || process.env.PAYMENT_SECRET_KEY || "",
    webhookSecret: str(cfg.webhook_secret) || process.env.PAYMENT_WEBHOOK_SECRET || "",
  };
}

export interface PaymentProcessorAdminSettings {
  enabled: boolean;
  provider: string;
  displayName: string;
  publishableKey: string;
  secretKeySet: boolean;
  webhookSecretSet: boolean;
}

export async function getPaymentProcessorAdminSettings(): Promise<PaymentProcessorAdminSettings> {
  const config = await getPaymentProcessorRuntimeConfig();
  return {
    enabled: config.enabled,
    provider: config.provider,
    displayName: config.displayName,
    // Publishable key is not secret by definition (it ships to the browser).
    publishableKey: config.publishableKey,
    secretKeySet: Boolean(config.secretKey),
    webhookSecretSet: Boolean(config.webhookSecret),
  };
}
