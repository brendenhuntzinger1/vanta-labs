import "server-only";

import { getShippoStatus, type ShippoMode } from "@/lib/shippo/config";
import { getInventorySettings } from "@/lib/inventory-settings";

// -------------------------------------------------------------------------
// Admin-facing fulfillment settings.
//
// Vanta Labs fulfils its own orders. There is no provider to connect, so there
// are no provider credentials, no API base URL, no outbound webhook secret and
// no payout model here — all of that belonged to the former 3PL and is gone.
//
// What remains is genuinely ours: whether stock levels gate sales, and whether
// shipping labels can be purchased. The Shippo token is configured in the
// server environment (SHIPPO_API_TOKEN), NOT in this dashboard, so it can never
// be read back through an admin API response.
// -------------------------------------------------------------------------

export interface FulfillmentAdminSettings {
  /** Whether stored stock levels gate purchases on the storefront. */
  inventoryTrackingEnabled: boolean;
  shippo: {
    configured: boolean;
    mode: ShippoMode;
    /** "TEST" | "LIVE" | "Not configured" — never the token itself. */
    label: string;
  };
}

export async function getFulfillmentAdminSettings(): Promise<FulfillmentAdminSettings> {
  const [inventory, shippo] = await Promise.all([getInventorySettings(), Promise.resolve(getShippoStatus())]);
  return {
    inventoryTrackingEnabled: inventory.trackingEnabled,
    shippo: { configured: shippo.configured, mode: shippo.mode, label: shippo.label },
  };
}
