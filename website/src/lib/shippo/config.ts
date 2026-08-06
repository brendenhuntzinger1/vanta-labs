import "server-only";

// -------------------------------------------------------------------------
// Shippo credentials and mode.
//
// SECURITY: the token is read from the server environment only and is NEVER
// returned by any export in this file. Everything here answers questions
// ABOUT the token (is it set? which mode?) without handing it out, so a
// careless `JSON.stringify(status)` in an admin response can't leak it. The
// one function that returns the raw value, requireShippoToken(), is used
// solely to build the Authorization header inside the client.
//
// There is deliberately no NEXT_PUBLIC_ variant. A Shippo token can purchase
// postage and read every shipment address on the account; it must never reach
// a browser.
// -------------------------------------------------------------------------

export type ShippoMode = "test" | "live";

export interface ShippoStatus {
  configured: boolean;
  mode: ShippoMode;
  /** Safe to render in admin UI — reveals nothing beyond the mode. */
  label: string;
}

function rawToken(): string {
  return (process.env.SHIPPO_API_TOKEN ?? "").trim();
}

/**
 * Shippo issues `shippo_test_...` and `shippo_live_...` tokens. The prefix is
 * the authoritative signal for which mode we're in — never a separate env flag,
 * which could disagree with the token actually in use and make the admin UI
 * claim TEST while real postage is being purchased.
 *
 * Anything that isn't recognisably a live token is treated as test. Guessing
 * "live" from an unfamiliar prefix would be the dangerous direction.
 */
export function shippoMode(): ShippoMode {
  return rawToken().startsWith("shippo_live_") ? "live" : "test";
}

export function isShippoConfigured(): boolean {
  return rawToken().length > 0;
}

/**
 * Whether real postage would be charged. Every money-spending path checks this
 * so the admin UI can warn before a live purchase.
 */
export function isShippoLive(): boolean {
  return isShippoConfigured() && shippoMode() === "live";
}

export function getShippoStatus(): ShippoStatus {
  const configured = isShippoConfigured();
  const mode = shippoMode();
  return {
    configured,
    mode,
    label: !configured ? "Not configured" : mode === "live" ? "LIVE" : "TEST",
  };
}

export class ShippoNotConfiguredError extends Error {
  constructor() {
    super("Shippo is not configured. Set SHIPPO_API_TOKEN in the server environment.");
    this.name = "ShippoNotConfiguredError";
  }
}

/**
 * The raw token, for the Authorization header only.
 *
 * Throws rather than returning "" so a missing token surfaces as a clear,
 * catchable error at the call site instead of an opaque 401 from Shippo.
 */
export function requireShippoToken(): string {
  const token = rawToken();
  if (!token) {
    throw new ShippoNotConfiguredError();
  }
  return token;
}
