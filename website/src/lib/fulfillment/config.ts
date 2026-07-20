import "server-only";

import { getControlSnapshot } from "@/lib/admin-control";

// -------------------------------------------------------------------------
// 3PL / fulfillment configuration.
//
// Provider-agnostic: connect any 3PL by entering its API base URL + key in the
// admin dashboard. Stored in the "fulfillment" control section, layered over
// env. Secrets never leave the server in plaintext (admin view is masked).
//
// Modes:
//   - "manual": no API calls. Paid orders are still queued and payout
//     reports/invoices are generated, so you always know what's owed. This is
//     the safe default until credentials are entered.
//   - "generic_rest": POSTs a normalized order to `${apiBaseUrl}/orders` with a
//     Bearer token. Works with any REST 3PL that accepts a standard order
//     payload; swapping providers is just new credentials, no code changes.
// -------------------------------------------------------------------------

export type FulfillmentMode = "manual" | "generic_rest";
export type PayoutModel = "per_unit" | "percent";

export interface FulfillmentRuntimeConfig {
  enabled: boolean;
  autoTransmit: boolean;
  mode: FulfillmentMode;
  providerName: string;
  apiBaseUrl: string;
  apiKey: string;
  webhookSecret: string;
  payoutModel: PayoutModel;
  payoutRate: number; // $/unit for per_unit, or percent for percent
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return fallback;
}

export async function getFulfillmentRuntimeConfig(): Promise<FulfillmentRuntimeConfig> {
  let cfg: Record<string, unknown> = {};
  try {
    const snapshot = await getControlSnapshot("fulfillment");
    cfg = snapshot.fulfillment ?? {};
  } catch {
    cfg = {};
  }

  const modeRaw = (str(cfg.mode) || "manual").toLowerCase();
  const mode: FulfillmentMode = modeRaw === "generic_rest" ? "generic_rest" : "manual";
  const payoutModelRaw = (str(cfg.payout_model) || "per_unit").toLowerCase();
  const payoutModel: PayoutModel = payoutModelRaw === "percent" ? "percent" : "per_unit";

  return {
    enabled: bool(cfg.enabled, false),
    autoTransmit: bool(cfg.auto_transmit, true),
    mode,
    providerName: str(cfg.provider_name) || (mode === "generic_rest" ? "generic_rest" : "manual"),
    apiBaseUrl: str(cfg.api_base_url).replace(/\/+$/, ""),
    apiKey: str(cfg.api_key) || process.env.FULFILLMENT_API_KEY || "",
    webhookSecret: str(cfg.webhook_secret) || process.env.FULFILLMENT_WEBHOOK_SECRET || "",
    payoutModel,
    payoutRate: Number(cfg.payout_rate ?? 0) || 0,
  };
}

export interface FulfillmentAdminSettings {
  enabled: boolean;
  autoTransmit: boolean;
  mode: FulfillmentMode;
  providerName: string;
  apiBaseUrl: string;
  apiKeySet: boolean;
  webhookSecretSet: boolean;
  payoutModel: PayoutModel;
  payoutRate: number;
  /** True when the mode can actually transmit (or manual, which always can). */
  ready: boolean;
}

export async function getFulfillmentAdminSettings(): Promise<FulfillmentAdminSettings> {
  const c = await getFulfillmentRuntimeConfig();
  const ready = c.mode === "manual" ? true : Boolean(c.apiBaseUrl && c.apiKey);
  return {
    enabled: c.enabled,
    autoTransmit: c.autoTransmit,
    mode: c.mode,
    providerName: c.providerName,
    apiBaseUrl: c.apiBaseUrl,
    apiKeySet: Boolean(c.apiKey),
    webhookSecretSet: Boolean(c.webhookSecret),
    payoutModel: c.payoutModel,
    payoutRate: c.payoutRate,
    ready,
  };
}
