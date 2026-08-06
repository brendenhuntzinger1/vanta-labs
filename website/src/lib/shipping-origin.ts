import "server-only";

import { getControlSnapshot } from "@/lib/admin-control";

// -------------------------------------------------------------------------
// The two addresses a parcel needs, which are NOT the same thing.
//
//   ORIGIN  (Shippo `address_from`)   — where the parcel physically ships from.
//                                       Drives the rate: carriers price on the
//                                       real origin ZIP, so this must be true.
//   RETURN  (Shippo `address_return`) — where an undeliverable parcel comes
//                                       back to, and the address a customer
//                                       reads off the package.
//
// They are separate because the origin is frequently a home address and the
// owner has no wish to print it on every parcel a stranger receives. Shippo
// defaults `address_return` to `address_from` when it is omitted, which is
// exactly the leak we are avoiding — so the return address is configured
// independently and only falls back to the origin when the owner has not set
// one.
//
// NEITHER IS HARDCODED. Both live in admin control settings (database), not in
// the repository and not in environment variables: they are business data the
// owner edits, and a home address does not belong in version control where it
// would persist in git history forever.
//
// Nothing is defaulted to a placeholder. A syntactically valid but wrong
// address is worse than a missing one — Shippo quotes happily against it and
// every label is wrong, which surfaces only when a parcel fails to deliver and
// then cannot come back either.
// -------------------------------------------------------------------------

export interface ShippingAddress {
  name: string;
  company: string;
  street1: string;
  street2: string;
  city: string;
  /** Two-letter state code. Carriers reject a US shipment without it. */
  state: string;
  zip: string;
  country: string;
  phone: string;
  email: string;
}

export const EMPTY_ADDRESS: ShippingAddress = {
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

export function parseAddress(cfg: Record<string, unknown> | null | undefined): ShippingAddress {
  const c = cfg ?? {};
  return {
    name: str(c.name),
    company: str(c.company),
    street1: str(c.street1),
    street2: str(c.street2),
    city: str(c.city),
    state: str(c.state).toUpperCase().slice(0, 2),
    zip: str(c.zip),
    country: (str(c.country) || "US").toUpperCase().slice(0, 2),
    phone: str(c.phone),
    email: str(c.email),
  };
}

/**
 * True when every field is blank — i.e. the owner has not configured this
 * address at all, as distinct from having configured it badly.
 */
export function isAddressEmpty(address: ShippingAddress): boolean {
  return (Object.keys(EMPTY_ADDRESS) as Array<keyof ShippingAddress>)
    .filter((key) => key !== "country")
    .every((key) => !address[key]);
}

/**
 * The fields carriers actually require. `company`, `street2` and `email` are
 * genuinely optional; the rest are not.
 *
 * `phone` is required because UPS and FedEx reject a shipment without one while
 * USPS does not — so omitting it half-works: USPS rates appear, the other two
 * silently return nothing, and it reads as "those carriers aren't enabled"
 * rather than "the address is incomplete".
 */
export const REQUIRED_ADDRESS_FIELDS = ["name", "street1", "city", "state", "zip", "country", "phone"] as const;

export interface AddressValidation {
  isComplete: boolean;
  /** Field names still needed, so the admin message can name them. */
  missing: string[];
}

export function validateAddress(address: ShippingAddress): AddressValidation {
  const missing = REQUIRED_ADDRESS_FIELDS.filter((field) => !address[field]);
  return { isComplete: missing.length === 0, missing: [...missing] };
}

/** Back-compat alias — the origin is just an address with a specific role. */
export const REQUIRED_ORIGIN_FIELDS = REQUIRED_ADDRESS_FIELDS;
export const validateShippingOrigin = validateAddress;
export type ShippingOrigin = ShippingAddress;

async function readSection(section: string): Promise<ShippingAddress> {
  try {
    const snapshot = await getControlSnapshot(section);
    return parseAddress((snapshot as Record<string, unknown>)[section] as Record<string, unknown>);
  } catch {
    return { ...EMPTY_ADDRESS };
  }
}

/** Where parcels physically ship from. Rated by the carrier — must be accurate. */
export async function getShippingOrigin(): Promise<ShippingAddress> {
  return readSection("shipping_origin");
}

/** The customer-facing return address, as configured (may be entirely blank). */
export async function getConfiguredReturnAddress(): Promise<ShippingAddress> {
  return readSection("shipping_return_address");
}

export interface ResolvedShippingAddresses {
  /** Shippo address_from. */
  origin: ShippingAddress;
  /** Shippo address_return — the configured one, or the origin as fallback. */
  returnAddress: ShippingAddress;
  /**
   * False when no separate return address is configured, meaning the ORIGIN
   * will be printed on the label. The admin UI warns on this, because for a
   * home-address origin it is a privacy leak rather than a mere default.
   */
  usesSeparateReturn: boolean;
  originValidation: AddressValidation;
  returnValidation: AddressValidation;
  /** Rates can be requested — the origin alone gates this. */
  canRequestRates: boolean;
}

/**
 * Resolve both addresses together, since callers almost always need the pair
 * and the fallback rule must be applied in exactly one place.
 *
 * An INCOMPLETE return address falls back to the origin rather than being sent
 * half-populated: a partial return address is rejected by carriers or, worse,
 * silently accepted and printed unusable.
 */
export async function getShippingAddresses(): Promise<ResolvedShippingAddresses> {
  const [origin, configuredReturn] = await Promise.all([getShippingOrigin(), getConfiguredReturnAddress()]);

  const originValidation = validateAddress(origin);
  const returnValidation = validateAddress(configuredReturn);
  const usesSeparateReturn = !isAddressEmpty(configuredReturn) && returnValidation.isComplete;

  return {
    origin,
    returnAddress: usesSeparateReturn ? configuredReturn : origin,
    usesSeparateReturn,
    originValidation,
    returnValidation,
    canRequestRates: originValidation.isComplete,
  };
}
