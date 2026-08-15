import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { isInventoryTrackingActive } from "@/lib/inventory-settings";

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
 * The response reports availability NET of live reservations, matching what the
 * product page shows, so the two screens cannot disagree.
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
  /** What the cart currently holds. */
  requested: number;
  /** Sellable units, or null when availability is not being counted. */
  available: number | null;
  /** The quantity the cart should be reduced to; equals `requested` when fine. */
  allowed: number;
  name: string | null;
}

const MAX_LINES = 50;

export async function POST(request: Request) {
  try {
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
        lines: lines.map((line) => ({ ...line, available: null, allowed: line.requested, name: null })),
      });
    }

    const doseIds = lines.map((line) => line.variantId).filter((id): id is string => Boolean(id));
    const slugs = Array.from(new Set(lines.filter((line) => !line.variantId).map((line) => line.slug)));

    const [doseResult, productResult] = await Promise.all([
      doseIds.length > 0
        ? supabaseAdmin
            .from("product_doses")
            .select("id, label, inventory_quantity, reserved_quantity")
            .in("id", doseIds)
        : Promise.resolve({ data: [], error: null }),
      slugs.length > 0
        ? supabaseAdmin
            .from("products")
            .select("slug, name, inventory_quantity, reserved_quantity")
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
        lines: lines.map((line) => ({ ...line, available: null, allowed: line.requested, name: null })),
      });
    }

    const sellable = (onHand: unknown, reserved: unknown) =>
      Math.max(0, Number(onHand ?? 0) - Number(reserved ?? 0));

    const byDoseId = new Map<string, { available: number; name: string | null }>();
    for (const row of doseResult.data ?? []) {
      byDoseId.set(String(row.id), {
        available: sellable(row.inventory_quantity, row.reserved_quantity),
        name: row.label ? String(row.label) : null,
      });
    }

    const bySlug = new Map<string, { available: number; name: string | null }>();
    for (const row of productResult.data ?? []) {
      bySlug.set(String(row.slug), {
        available: sellable(row.inventory_quantity, row.reserved_quantity),
        name: row.name ? String(row.name) : null,
      });
    }

    const validated: CartLineValidation[] = lines.map((line) => {
      const match = line.variantId ? byDoseId.get(line.variantId) : bySlug.get(line.slug);
      // A row we cannot find is left alone rather than zeroed — an unknown line
      // is a lookup gap, not a sold-out product.
      if (!match) {
        return { ...line, available: null, allowed: line.requested, name: null };
      }
      return {
        ...line,
        available: match.available,
        allowed: Math.min(line.requested, match.available),
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
