import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * PRODUCT VIEWS, RECORDED FOR THE BROWSE FOLLOW-UP.
 *
 * The wall means every product viewer is a signed-in account, and the product
 * page resolves the viewer server-side, so a view can be recorded against a
 * consented address with no script in the browser. Visitors on a marketing-
 * link grant are NOT recorded: they have no account and no consent record of
 * their own.
 *
 * ONE ROW PER ADDRESS, PRODUCT AND HOUR. The unique index on
 * (email, slug, viewed_hour) turns a refresh into a no-op instead of a tenth
 * row, and the upsert below asks for duplicates to be ignored rather than
 * reported, so the write is idempotent inside the hour.
 *
 * NEVER BLOCKS AND NEVER FAILS THE PAGE. Scheduled with Next's after() by the
 * caller, and every failure is swallowed here: a lost view costs one follow-up
 * email; a product page that errors on an analytics write costs a sale.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Views older than this are of no use to the follow-up and are pruned by the sweep. */
export const PRODUCT_VIEW_RETENTION_MS = 30 * 24 * HOUR_MS;

export async function recordProductView(input: {
  email: string;
  customerUserId?: string | null;
  slug: string;
  at?: number;
}): Promise<void> {
  const email = String(input.email ?? "").trim().toLowerCase();
  const slug = String(input.slug ?? "").trim();
  if (!email || !slug) return;
  const at = Number.isFinite(input.at) ? Number(input.at) : Date.now();
  const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
  try {
    const { error } = await supabaseAdmin
      .from("product_views")
      .upsert(
        {
          email,
          customer_user_id: input.customerUserId ?? null,
          slug,
          viewed_at: new Date(at).toISOString(),
          viewed_hour: new Date(hour).toISOString(),
        },
        { onConflict: "email,slug,viewed_hour", ignoreDuplicates: true },
      );
    if (error) console.error("[product-views] record failed", error.message);
  } catch (error) {
    console.error("[product-views] record threw", error instanceof Error ? error.message : String(error));
  }
}

/** The newest view per address inside the window, keyed by lowercase email. */
export async function loadRecentProductViews(input: {
  now: number;
  windowMs: number;
}): Promise<Map<string, { slug: string; at: number }>> {
  const latest = new Map<string, { slug: string; at: number }>();
  const PAGE = 1000;
  const since = new Date(input.now - input.windowMs).toISOString();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("product_views")
      .select("email, slug, viewed_at")
      .gte("viewed_at", since)
      .order("viewed_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ email?: string | null; slug?: string | null; viewed_at?: string | null }>;
    for (const row of rows) {
      const email = String(row.email ?? "").trim().toLowerCase();
      const slug = String(row.slug ?? "").trim();
      const at = Date.parse(String(row.viewed_at ?? ""));
      if (!email || !slug || !Number.isFinite(at)) continue;
      // Ordered newest first, so the first row seen for an address is its latest view.
      if (!latest.has(email)) latest.set(email, { slug, at });
    }
    if (rows.length < PAGE) break;
  }
  return latest;
}

/** Best-effort: rows past the retention window are deleted; a failure is logged, never thrown. */
export async function pruneProductViews(now: number): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from("product_views")
      .delete()
      .lt("viewed_at", new Date(now - PRODUCT_VIEW_RETENTION_MS).toISOString());
    if (error) console.error("[product-views] prune failed", error.message);
  } catch (error) {
    console.error("[product-views] prune threw", error instanceof Error ? error.message : String(error));
  }
}
