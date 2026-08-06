import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageSettings } from "@/lib/admin-roles";
import { upsertControlValue } from "@/lib/admin-control";
import {
  getShippingAddresses,
  parseAddress,
  validateAddress,
  type ShippingAddress,
} from "@/lib/shipping-origin";

export const dynamic = "force-dynamic";

// -------------------------------------------------------------------------
// Ship-from origin and customer-facing return address.
//
// These are stored in admin control settings, never in the repository: the
// origin is typically a home address, and anything committed lives in git
// history permanently even after a later edit.
//
// Both endpoints are admin-gated. The origin is not a secret in the credential
// sense, but it is the owner's home address — a customer, or an unauthenticated
// caller, has no business reading it back out of an API.
// -------------------------------------------------------------------------

const ADDRESS_KEYS = [
  "name",
  "company",
  "street1",
  "street2",
  "city",
  "state",
  "zip",
  "country",
  "phone",
  "email",
] as const;

function unauthorized() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

function forbidden() {
  return NextResponse.json(
    { success: false, error: "Your role does not have permission to change settings." },
    { status: 403 },
  );
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorized();
  if (!canManageSettings(session.role)) return forbidden();

  const resolved = await getShippingAddresses();
  return NextResponse.json({ success: true, ...resolved });
}

export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorized();
  if (!canManageSettings(session.role)) return forbidden();

  const ipAddress = getRequestIpAddress(request);
  const userAgent = getRequestUserAgent(request);
  const meta = { actorUsername: session.username, ipAddress, userAgent };

  try {
    const body = (await request.json()) as {
      origin?: Record<string, unknown>;
      returnAddress?: Record<string, unknown>;
    };

    // Normalize through parseAddress so trimming, and the uppercase two-letter
    // state/country rules, are applied in exactly one place rather than being
    // re-implemented per caller.
    const writeSection = async (section: string, raw: Record<string, unknown>) => {
      const address: ShippingAddress = parseAddress(raw);
      for (const key of ADDRESS_KEYS) {
        await upsertControlValue({ section, key, value: address[key], ...meta });
      }
      return address;
    };

    let origin: ShippingAddress | null = null;
    let returnAddress: ShippingAddress | null = null;

    if (body.origin) origin = await writeSection("shipping_origin", body.origin);
    if (body.returnAddress) returnAddress = await writeSection("shipping_return_address", body.returnAddress);

    // The address itself is deliberately NOT written to the audit log — that
    // table is read by more eyes than the settings screen, and duplicating a
    // home address into it defeats the point of keeping it out of the repo.
    // Which section changed is enough to answer "who changed the origin, when".
    await upsertControlValue({
      section: "shipping_origin_audit",
      key: "last_updated",
      value: { at: new Date().toISOString(), by: session.username, sections: [
        origin ? "origin" : null,
        returnAddress ? "return" : null,
      ].filter(Boolean) },
      ...meta,
    });

    const resolved = await getShippingAddresses();
    return NextResponse.json({
      success: true,
      ...resolved,
      // Surfaced so the UI can explain precisely what is still missing rather
      // than a generic "incomplete".
      originValidation: validateAddress(resolved.origin),
    });
  } catch (error) {
    console.error("Unable to save shipping addresses", error);
    return NextResponse.json({ success: false, error: "Unable to save shipping addresses." }, { status: 500 });
  }
}
