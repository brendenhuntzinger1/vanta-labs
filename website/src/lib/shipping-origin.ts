import "server-only";

import { getControlSnapshot } from "@/lib/admin-control";

// -------------------------------------------------------------------------
// The address parcels ship FROM.
//
// Shippo cannot quote a rate without an origin, so this is a hard prerequisite
// for the whole fulfillment flow rather than a nicety. It is also the RETURN
// ADDRESS printed on every label, which is why it lives in admin settings and
// not in an env var: it is business data the owner will correct, not a
// deployment secret.
//
// Nothing here is defaulted to a placeholder. A syntactically valid but wrong
// origin is worse than a missing one — Shippo would happily quote against it
// and every label would carry the wrong return address, which only surfaces
// when a parcel fails to deliver and cannot come back. Missing fields make
// isComplete() false and the admin UI blocks rate requests with a clear reason.
// -------------------------------------------------------------------------

export interface ShippingOrigin {
  name: string;
  company: string;
  street1: string;
  street2: string;
  city: string;
  /** Two-letter state code. Shippo rejects a US shipment without it. */
  state: string;
  zip: string;
  country: string;
  phone: string;
  email: string;
}

const EMPTY: ShippingOrigin = {
  name: "",
  company: "",
  street1: "",
  street2: "",
  city: "",
  state: "",
  zip: "",
  country: "US",
  phone: "",
  email: "",
};

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function getShippingOrigin(): Promise<ShippingOrigin> {
  try {
    const snapshot = await getControlSnapshot("shipping_origin");
    const cfg = (snapshot.shipping_origin ?? {}) as Record<string, unknown>;
    return {
      name: str(cfg.name),
      company: str(cfg.company),
      street1: str(cfg.street1),
      street2: str(cfg.street2),
      city: str(cfg.city),
      state: str(cfg.state).toUpperCase().slice(0, 2),
      zip: str(cfg.zip),
      country: str(cfg.country) || "US",
      phone: str(cfg.phone),
      email: str(cfg.email),
    };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * The fields a carrier actually requires. `street2`, `company` and `email` are
 * genuinely optional; the rest are not.
 *
 * `phone` is included because UPS and FedEx reject a shipment without one — USPS
 * does not, so omitting it produces the confusing result of USPS rates
 * appearing while the other carriers silently return nothing.
 */
export const REQUIRED_ORIGIN_FIELDS = ["name", "street1", "city", "state", "zip", "country", "phone"] as const;

export interface OriginValidation {
  isComplete: boolean;
  /** Field names still needed, for a precise admin message. */
  missing: string[];
}

export function validateShippingOrigin(origin: ShippingOrigin): OriginValidation {
  const missing = REQUIRED_ORIGIN_FIELDS.filter((field) => !origin[field]);
  return { isComplete: missing.length === 0, missing: [...missing] };
}

export async function getValidatedShippingOrigin(): Promise<ShippingOrigin & OriginValidation> {
  const origin = await getShippingOrigin();
  return { ...origin, ...validateShippingOrigin(origin) };
}
