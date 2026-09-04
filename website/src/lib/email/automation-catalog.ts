// No `server-only` here: the admin composer (a Client Component) needs the
// labels, and automations.ts — which is server-only — re-exports everything
// below so server code keeps importing from one place.

/**
 * IN PRIORITY ORDER. The sweep runs them top to bottom, and the quiet period in
 * frequency.ts means the first one to mail an address this sweep wins and the
 * rest wait. Closest to money first: a customer who just bought hears about
 * their order before anything else; a lapsed one hears from the win-back last.
 *
 *   post_purchase        → after a customer's FIRST paid order. Education, no ask.
 *   replenishment        → after EACH paid order, unless they have ordered since.
 *   welcome_intro        → a day after consent, no order yet. Who we are.
 *   welcome_no_purchase  → three days after consent, no order yet. The offer.
 *   winback_30 / _60     → "Win-back 1" and "Win-back 2", by last order date.
 *                          The keys carry their original delays in the name
 *                          because they are stored in email_send_log and
 *                          shown in reports; the DELAY is the operator's,
 *                          edited in the admin.
 */
export const AUTOMATION_KEYS = [
  "post_purchase",
  "replenishment",
  "welcome_intro",
  "welcome_no_purchase",
  "winback_30",
  "winback_60",
] as const;
export type AutomationKey = (typeof AUTOMATION_KEYS)[number];

/** Operator-facing names. The key is a stable identifier, not a label. */
export const AUTOMATION_LABELS: Record<AutomationKey, { label: string; description: string }> = {
  post_purchase: {
    label: "First-order follow-up",
    description: "After a customer's first paid order. What is in the box, how to read the COA, who to ask. No offer.",
  },
  replenishment: {
    label: "Reorder reminder",
    description: "After each paid order, timed to the research cycle. Stops if they have ordered again since.",
  },
  welcome_intro: {
    label: "Welcome · introduction",
    description: "The day after someone subscribes without ordering. Who Vanta is and how ordering works. No offer.",
  },
  welcome_no_purchase: {
    label: "Welcome · first-order offer",
    description: "A few days after subscribing, still no order. Carries the first-order gift if one is set.",
  },
  winback_30: {
    label: "Win-back 1",
    description: "The first message once a customer has gone quiet. Keep the offer light — most will reorder anyway.",
  },
  winback_60: {
    label: "Win-back 2",
    description: "The stronger message for someone who did not respond to the first. This is where the gift belongs.",
  },
};

/**
 * EVENT-KEYED FLOWS DO NOT BACKFILL.
 *
 * Switching on "reorder reminder" with a 30-day delay must not mail every
 * customer whose order is older than 30 days — six months on, "time to
 * restock?" is not a reminder, it is noise, and a burst of it is how a
 * sending domain gets a reputation. So an event (consent, an order) older than
 * delay + this grace never triggers. Win-backs are exempt: "it has been a
 * while" is true of a 400-day lapse, and the batch cap paces those.
 */
export const EVENT_GRACE_DAYS = 14;

export function isAutomationKey(value: unknown): value is AutomationKey {
  return AUTOMATION_KEYS.includes(value as AutomationKey);
}

