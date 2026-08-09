import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import {
  hasAnyAttribution,
  sanitizeAttributionRecord,
  toOrderAttributionRow,
  type AttributionRecord,
} from "@/lib/attribution";

// ---------------------------------------------------------------------------
// Writing and reading the order <-> campaign link.
//
// ANALYTICS OBSERVES COMMERCE; IT NEVER CONTROLS IT. Every function here is
// non-throwing by construction. The order is already committed by the time any
// of this runs, so the worst outcome of a total failure — a missing table, a
// dead connection, a malformed client payload — is an order with no attribution
// row. That is a reporting gap, and reporting gaps are recoverable. An
// exception escaping into the checkout controller would not be.
//
// It also means this module can ship before its migration has been run: the
// insert fails, the failure is logged, checkout is unaffected.
// ---------------------------------------------------------------------------

const ATTRIBUTION_TABLE = "order_attribution";

/**
 * Persist what we know about how this order was acquired.
 *
 * `raw` comes from the browser and is treated as hostile — `sanitizeAttributionRecord`
 * re-validates every field and discards any touch without genuine campaign
 * evidence, so a crafted checkout request cannot manufacture an attributed sale.
 *
 * When there is nothing credible to record, NO ROW IS WRITTEN. A missing row is
 * how this schema says "we don't know", and it has to stay distinguishable from
 * a row of nulls — otherwise "unattributed" and "organic" collapse into the
 * same thing and the paid/organic split stops meaning anything.
 */
export async function recordOrderAttribution(input: {
  orderId: string;
  raw: unknown;
  now?: Date;
}): Promise<{ recorded: boolean; reason?: string }> {
  try {
    const orderId = String(input.orderId ?? "").trim();
    if (!orderId) {
      return { recorded: false, reason: "missing_order_id" };
    }

    const now = input.now ?? new Date();
    const record = sanitizeAttributionRecord(input.raw, now);

    if (!record || !hasAnyAttribution(record)) {
      return { recorded: false, reason: "no_attribution" };
    }

    // Upsert rather than insert: the express lane can retry, and a second
    // attempt for the same order should refresh the row rather than error.
    const { error } = await supabaseAdmin
      .from(ATTRIBUTION_TABLE)
      .upsert(toOrderAttributionRow(orderId, record), { onConflict: "order_id" });

    if (error) {
      console.error("Attribution: unable to persist order attribution", orderId, error.message);
      return { recorded: false, reason: "write_failed" };
    }

    return { recorded: true };
  } catch (error) {
    // Deliberately swallowed. See the module header: an order that is already
    // paid for must never be disturbed by a telemetry problem.
    console.error("Attribution: unexpected failure recording order attribution", error);
    return { recorded: false, reason: "exception" };
  }
}

/** Read an order's attribution back, or null when we never knew. Non-throwing
 *  for the same reason — its only caller is an analytics side-effect inside the
 *  payment webhook. */
export async function getOrderAttribution(orderId: string): Promise<AttributionRecord | null> {
  try {
    const id = String(orderId ?? "").trim();
    if (!id) return null;

    const { data, error } = await supabaseAdmin
      .from(ATTRIBUTION_TABLE)
      .select("*")
      .eq("order_id", id)
      .maybeSingle();

    if (error || !data) return null;

    const row = data as Record<string, unknown>;
    const touch = (prefix: "first" | "last") => {
      const at = row[`${prefix}_touch_at`];
      if (!at) return null;
      return {
        utmSource: (row[`${prefix}_utm_source`] as string) ?? null,
        utmMedium: (row[`${prefix}_utm_medium`] as string) ?? null,
        utmCampaign: (row[`${prefix}_utm_campaign`] as string) ?? null,
        utmContent: (row[`${prefix}_utm_content`] as string) ?? null,
        utmTerm: (row[`${prefix}_utm_term`] as string) ?? null,
        ttclid: (row[`${prefix}_ttclid`] as string) ?? null,
        fbclid: (row[`${prefix}_fbclid`] as string) ?? null,
        gclid: (row[`${prefix}_gclid`] as string) ?? null,
        landingPath: (row[`${prefix}_landing_path`] as string) ?? null,
        referrer: (row[`${prefix}_referrer`] as string) ?? null,
        at: String(at),
      };
    };

    return {
      visitorId: (row.visitor_id as string) ?? null,
      sessionId: (row.session_id as string) ?? null,
      first: touch("first"),
      last: touch("last"),
    };
  } catch (error) {
    console.error("Attribution: unable to read order attribution", error);
    return null;
  }
}
