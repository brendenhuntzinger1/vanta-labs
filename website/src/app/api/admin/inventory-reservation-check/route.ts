import { NextResponse } from "next/server";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { checkInventoryReservation } from "@/lib/inventory-reservation-check";

/**
 * Is the inventory reservation architecture actually live?
 *
 * Read-only in the strictest sense: it reads two columns, one table and the
 * schema the database publishes about itself. It calls none of the reservation
 * functions, because calling them to prove they exist would hold or decrement
 * real stock.
 *
 * Admin-gated — it reports which database objects exist, which is not
 * information an anonymous request should be able to enumerate.
 */
export async function GET() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) return NextResponse.json({ error: "admin session required" }, { status: 401 });

  return NextResponse.json(await checkInventoryReservation(), {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
