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
  recordSend: (eventName: string, eventId: string, delivered: boolean, error: string | null) => Promise<void>;
  releaseSend: (eventName: string) => Promise<void>;
};

export function omnisendLedger(entityId: string): OmnisendLedger {
  return {
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
}
