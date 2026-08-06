import "server-only";

import { getControlSnapshot } from "@/lib/admin-control";

// -------------------------------------------------------------------------
// Whether stored stock levels actually GATE sales on the storefront.
//
// WHY THIS EXISTS SEPARATELY: this flag used to live on the 3PL integration
// config, so "is inventory real?" was answered by "is the fulfilment provider
// connected?". The provider owned availability — resolveStockStatus in
// catalog.ts returned "In Stock" for every product whenever the integration was
// off, which it was by default. Vanta Labs now fulfils its own orders, so the
// question has nothing to do with any provider and belongs here.
//
// DEFAULT IS OFF, DELIBERATELY. Turning this on makes stored "Out of Stock"
// statuses and zero quantities start blocking purchases immediately. If the
// products table has stale or unpopulated quantities — likely, since nothing
// has been enforcing them — flipping this on without checking would silently
// pull sellable products off the storefront. Populate real quantities in
// /admin/inventory FIRST, confirm they look right, then enable this.
// -------------------------------------------------------------------------

export interface InventorySettings {
  /** When true, stored stock status/quantity is authoritative for buyability. */
  trackingEnabled: boolean;
}

export async function getInventorySettings(): Promise<InventorySettings> {
  try {
    const snapshot = await getControlSnapshot("inventory");
    const cfg = (snapshot.inventory ?? {}) as Record<string, unknown>;
    const raw = cfg.tracking_enabled;
    const trackingEnabled =
      typeof raw === "boolean" ? raw : typeof raw === "string" ? raw.toLowerCase() === "true" : false;
    return { trackingEnabled };
  } catch {
    // Fail open to "not tracking" — the same direction the old code failed. An
    // unreadable setting must never make the whole catalog unpurchasable.
    return { trackingEnabled: false };
  }
}

/**
 * Whether stored stock levels gate sales right now. Callers use this to decide
 * if a stored "Out of Stock" is honoured or overridden to "In Stock".
 */
export async function isInventoryTrackingActive(): Promise<boolean> {
  return (await getInventorySettings()).trackingEnabled;
}
