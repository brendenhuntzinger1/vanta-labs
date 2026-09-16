import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * Exactly-once for Omnisend events, one row per (entity, event name).
 *
 * Copied from the ad ledger (ads/meta-purchase-sync.ts metaLedger) because
 * the contract there is the one that survived production:
 *
 *   * the CLAIM is an INSERT, not a read. Two callers — the payment webhook
 *     and the backstop sweep — can ask at the same moment; a read-then-write
 *     lets both see "unsent". The unique key lets exactly one insert land.
 *   * 23505 (duplicate key) means somebody else has it: return false.
 *   * any OTHER failure returns TRUE. The ledger being unreachable must not
 *     silence the event; Omnisend deduplicates historical events on
 *     eventID + eventTime, so a rare duplicate costs nothing and a lost
 *     "paid for order" costs a post-purchase flow.
 *   * release deletes only an UNDELIVERED claim, so a delivered row can never
 *     be reopened by a late failure elsewhere.
 *
 * Deliberately its own table rather than ad_purchase_events_sent, which is
 * documented as an advertising ledger and carries a tiktok_code column.
 */

export type OmnisendLedger = {
  claimSend: (eventName: string, eventId: string) => Promise<boolean>;
  /**
   * Claim, or re-claim once the previous claim is older than the window.
   *
   * For the events that recur — a cart changing, a product being viewed —
   * exactly-once is the wrong contract; at-most-once-per-window is. The
   * insert is tried first, exactly as claimSend does, so a first report is
   * race-free. Only when the row already exists is it refreshed, and the
   * refresh is ONE conditional update on `first_sent_at < now - window`:
   * two beacons racing on the same cart both attempt it and the database
   * lets exactly one row-change through, so a read-then-update cannot let
   * both see "old". Fails OPEN on a ledger error, for the same reason the
   * claim does.
   */
  claimSendWithin: (eventName: string, eventId: string, windowMs: number) => Promise<boolean>;
  recordSend: (eventName: string, eventId: string, delivered: boolean, error: string | null) => Promise<void>;
  releaseSend: (eventName: string) => Promise<void>;
};

export function omnisendLedger(entityId: string): OmnisendLedger {
  const ledger: OmnisendLedger = {
    claimSend: async (eventName, eventId) => {
      try {
        const { error } = await supabaseAdmin
          .from("omnisend_events_sent")
          .insert({ entity_id: entityId, event_name: eventName, event_id: eventId, delivered: false });
        if (!error) return true;
        if ((error as { code?: string }).code === "23505") return false;
        return true;
      } catch {
        return true;
      }
    },
    claimSendWithin: async (eventName, eventId, windowMs) => {
      if (await ledger.claimSend(eventName, eventId)) return true;
      try {
        const now = Date.now();
        const { data, error } = await supabaseAdmin
          .from("omnisend_events_sent")
          .update({ event_id: eventId, delivered: false, first_sent_at: new Date(now).toISOString(), last_error: null })
          .eq("entity_id", entityId)
          .eq("event_name", eventName)
          .lt("first_sent_at", new Date(now - windowMs).toISOString())
          .select("entity_id");
        if (error) return true;
        return Array.isArray(data) && data.length > 0;
      } catch {
        return true;
      }
    },
    recordSend: async (eventName, eventId, delivered, error) => {
      try {
        await supabaseAdmin
          .from("omnisend_events_sent")
          .upsert(
            { entity_id: entityId, event_name: eventName, event_id: eventId, delivered, last_error: error },
            { onConflict: "entity_id,event_name" },
          );
      } catch {
        /* ledger unavailable; Omnisend's own historical dedup still applies */
      }
    },
    releaseSend: async (eventName) => {
      try {
        await supabaseAdmin
          .from("omnisend_events_sent")
          .delete()
          .eq("entity_id", entityId)
          .eq("event_name", eventName)
          .eq("delivered", false);
      } catch {
        /* the next ask is refused, which is the safe direction */
      }
    },
  };
  return ledger;
}
