import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { isInventoryTrackingActive } from "@/lib/inventory-settings";
import { MAX_UNITS_PER_ORDER_LINE } from "@/lib/purchase-limits";
import { checkRateLimit } from "@/lib/rate-limit";
import { getRequestIpAddress } from "@/lib/admin-auth";

/**
 * POST /api/cart/validate
 *
 * Re-check a cart's lines against live inventory.
 *
 * WHY THIS EXISTS. A cart lives in localStorage and can sit there for days. The
 * quantity in it is a snapshot of what was available when the shopper clicked
 * Add to Cart, and nothing about it is trustworthy afterwards — the last three
 * units may have sold in the meantime. The authoritative gate is still the
 * row-locked reserve_inventory() call at order creation; this endpoint exists so
 * the shopper learns about a shortfall on the cart page, where they can fix it,
 * rather than after filling in their address.
 *
 * It is deliberately advisory and read-only. It takes no holds and changes
 * nothing, so it cannot be used to deny another shopper stock by polling it,
 * and a wrong answer here can only produce a friendlier error one step earlier —
 * never a sale that should not have happened.
 *
 * Availability is computed NET of live reservations, matching what gates the
 * product page, so the two screens cannot disagree. The RAW COUNT NEVER LEAVES
 * THE SERVER: the response says only what each line may be reduced to and
 * whether it sold out. Returning the figure would hand any visitor a public
 * inventory API for the entire catalogue.
 */

interface CartLineInput {
  /** Stable cart line key, echoed back so the client can match lines up. */
  key?: string;
  slug?: string;
  variantId?: string | null;
  quantity?: number;
}

export interface CartLineValidation {
  key: string;
  slug: string;
  variantId: string | null;
  /** What the cart currently holds — the client's own input, echoed back. */
  requested: number;
  /**
   * The quantity this line should be reduced to; equals `requested` when the
   * line is fine.
   *
   * The raw sellable count is deliberately NOT in this response. The endpoint
   * answers "may I have this many", not "how many are there": a shopper needs
   * their cart corrected, and nothing more. Publishing the figure would make
   * this a public inventory API for the whole catalogue.
   */
  allowed: number;
  /** True when the line is gone entirely — the one stock fact customers see. */
  soldOut: boolean;
  name: string | null;
}

const MAX_LINES = 50;

/**
 * What a line may be reduced to — and the ONLY number this endpoint publishes.
 *
 * The third clamp is the important one, and it is not an optimisation. Without
 * it `allowed` is exactly `available` whenever the caller asks for more than
 * exists, so `{"quantity": 999999}` reads the live count back verbatim: an
 * unauthenticated, unpaginated inventory API for fifty SKUs per request. With
 * it, the largest number that can ever leave here is the per-line order
 * ceiling — precisely what publishableAvailability() already allows the catalog
 * to publish, so this route discloses nothing the product page does not.
 *
 * The cost is a genuine but rare under-offer: a shopper asking for 20 of
 * something with 15 left is reduced to 10 rather than 15. The product page
 * cannot even produce a line above the ceiling, so this only bites a cart hand-
 * stepped past it, and it errs toward selling less — never toward overselling.
 */
export function resolveAllowedQuantity(requested: number, available: number): number {
  return Math.max(0, Math.min(requested, available, MAX_UNITS_PER_ORDER_LINE));
}

export async function POST(request: Request) {
  try {
    // A real shopper validates their cart a handful of times per visit. Anyone
    // sweeping the catalogue does it thousands of times, so throttle by IP.
    // Fails open, like every other limiter here — availability checks must not
    // break for real customers if the limiter is unavailable.
    const ip = getRequestIpAddress(request) ?? "unknown";
    const rateLimit = await checkRateLimit(`cart-validate:${ip}`, 30, 60);
    if (!rateLimit.allowed) {
      const res = NextResponse.json({ success: true, tracking: false, degraded: true, lines: [] }, { status: 429 });
      res.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
      return res;
    }

    const body = await request.json().catch(() => ({}));
    const rawLines: CartLineInput[] = Array.isArray(body?.items) ? body.items.slice(0, MAX_LINES) : [];

    const lines = rawLines
      .map((line) => ({
        key: String(line.key ?? line.slug ?? ""),
        slug: String(line.slug ?? "").slice(0, 200),
        variantId: line.variantId ? String(line.variantId) : null,
        requested: Math.max(0, Math.trunc(Number(line.quantity ?? 0))),
      }))
      .filter((line) => line.slug && line.requested > 0);

    if (lines.length === 0) {
      return NextResponse.json({ success: true, tracking: false, lines: [] as CartLineValidation[] });
    }

    // With tracking off the store does not count units at all, so there is no
    // shortfall to report. Answering "0 available" here would empty carts across
    // the whole catalog — the exact failure the tracking flag exists to prevent.
    const tracking = await isInventoryTrackingActive();
    if (!tracking) {
      return NextResponse.json({
        success: true,
        tracking: false,
        lines: lines.map((line) => ({ ...line, allowed: line.requested, soldOut: false, name: null })),
      });
    }

    const doseIds = lines.map((line) => line.variantId).filter((id): id is string => Boolean(id));
    // EVERY requested slug, dose lines included — not just the bare-slug ones.
    // The products query is what establishes whether a row is publicly listed
    // at all, and a dose line needs that answer about its parent just as much
    // as a product line needs it about itself.
    const slugs = Array.from(new Set(lines.map((line) => line.slug)));

    const [doseResult, productResult] = await Promise.all([
      doseIds.length > 0
        ? supabaseAdmin
            .from("product_doses")
            // THE PARENT'S VISIBILITY COUNTS TOO. This branch checked only the
            // dose's own is_enabled, while the products branch below applies
            // the full public-catalog filter for the reason stated there: the
            // route must not answer stock questions about rows the storefront
            // does not even list. A dose inherits its visibility from its
            // product, so an unpublished or archived product's doses were
            // exactly such rows, and nearly every cart line carries a dose id
            // (quoteOrder rewrites bare slugs to `slug::doseId`) — so the
            // branch WITHOUT the filter was the common path, not the edge one.
            //
            // The customer-visible outcome is unchanged either way: a filtered
            // row is simply absent, and an absent row is left alone rather than
            // zeroed (see the `!match` branch below). This closes the
            // disclosure gap, not a checkout failure.
            //
            // Done with the slug the cart line already carries rather than an
            // embedded `products!inner(...)` filter: the visibility of the
            // parent is resolved by the products query below, which every
            // requested slug now goes through, and the match is dropped in code
            // if its slug did not come back. One less PostgREST relationship to
            // depend on, and it is checkable without a live database.
            .select("id, label, inventory_quantity, reserved_quantity, stock_status")
            .eq("is_enabled", true)
            .in("id", doseIds)
        : Promise.resolve({ data: [], error: null }),
      slugs.length > 0
        ? supabaseAdmin
            .from("products")
            .select("slug, name, inventory_quantity, reserved_quantity, stock_status")
            // Same visibility filters as every public catalog read. Without
            // them this route answers stock questions about unpublished and
            // archived rows that the storefront does not even list.
            .eq("is_enabled", true)
            .eq("is_published", true)
            .eq("is_archived", false)
            .in("slug", slugs)
        : Promise.resolve({ data: [], error: null }),
    ]);

    // A lookup failure must not empty anyone's cart. Fail open: report every
    // line as fine and let the atomic reservation do its job at checkout.
    if (doseResult.error || productResult.error) {
      console.error("[cart/validate] lookup failed", doseResult.error ?? productResult.error);
      return NextResponse.json({
        success: true,
        tracking: false,
        degraded: true,
        lines: lines.map((line) => ({ ...line, allowed: line.requested, soldOut: false, name: null })),
      });
    }

    // A stored "Out of Stock" or "Reserved" blocks the sale at checkout
    // (quote-order rejects the line outright), so the cart has to honour it too
    // — otherwise a line with a positive count but a blocking status sails
    // through this check and hard-fails at the payment step, which is the exact
    // late refusal this endpoint exists to prevent.
    const BLOCKING_STATUSES = new Set(["out of stock", "reserved"]);

    const sellable = (onHand: unknown, reserved: unknown, status: unknown) => {
      if (BLOCKING_STATUSES.has(String(status ?? "").trim().toLowerCase())) {
        return 0;
      }
      return Math.max(0, Number(onHand ?? 0) - Number(reserved ?? 0));
    };

    const byDoseId = new Map<string, { available: number; name: string | null }>();
    for (const row of doseResult.data ?? []) {
      byDoseId.set(String(row.id), {
        available: sellable(row.inventory_quantity, row.reserved_quantity, row.stock_status),
        name: row.label ? String(row.label) : null,
      });
    }

    const bySlug = new Map<string, { available: number; name: string | null }>();
    for (const row of productResult.data ?? []) {
      bySlug.set(String(row.slug), {
        available: sellable(row.inventory_quantity, row.reserved_quantity, row.stock_status),
        name: row.name ? String(row.name) : null,
      });
    }

    const validated: CartLineValidation[] = lines.map((line) => {
      // A dose is only as visible as the product it hangs off. `bySlug` holds
      // exactly the publicly-listed products, so a dose whose slug is missing
      // from it belongs to an unpublished or archived row and is treated as a
      // lookup gap — left alone, never zeroed, same as any other unknown line.
      const parentListed = bySlug.has(line.slug);
      const match = line.variantId
        ? (parentListed ? byDoseId.get(line.variantId) : undefined)
        : bySlug.get(line.slug);
      // A row we cannot find is left alone rather than zeroed — an unknown line
      // is a lookup gap, not a sold-out product.
      if (!match) {
        return { ...line, allowed: line.requested, soldOut: false, name: null };
      }
      return {
        ...line,
        allowed: resolveAllowedQuantity(line.requested, match.available),
        soldOut: match.available <= 0,
        name: match.name,
      };
    });

    return NextResponse.json({ success: true, tracking: true, lines: validated });
  } catch (error) {
    console.error("[cart/validate]", error);
    // Same fail-open contract as above.
    return NextResponse.json({ success: true, tracking: false, degraded: true, lines: [] });
  }
}
