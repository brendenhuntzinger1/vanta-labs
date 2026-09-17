import { omnisendOwnsMarketing } from "./config";

/**
 * ONE OWNER OF MARKETING SENDS (design spec §3.1).
 *
 * WHY THIS EXISTS. The in-house engine — the cart-recovery ladder, the
 * retention automations and the campaign sender — and Omnisend's flows must
 * never mail the same inbox on the same day. The obvious fix, coordination,
 * is not available: the site's 24-hour frequency guard (marketing_send_claim)
 * only knows about sends the site made, and it cannot see a message Omnisend
 * has sent or is about to send. Two systems that cannot see each other cannot
 * share a quiet period. So the fix is ownership: exactly one of them sends
 * marketing, decided by a single server setting, and the other stands down.
 *
 * WHY ONE FUNCTION. Every in-house sender that could put a marketing message
 * in front of a customer asks this and stops on a non-null answer — the three
 * lifecycle cron jobs, and the admin campaign send endpoint. The answer is the
 * reason that gets logged, so the cron response and the admin refusal say the
 * same words, and an operator reading either knows exactly which switch to
 * look at. The switch itself is read in config.ts and nowhere else; this
 * module only translates "does Omnisend own it" into "what do I tell the log".
 *
 * WHAT DOES NOT STAND DOWN. Transactional mail, retries of it, the reapers
 * that free stranded send-once slots, and the held-back event queue are not
 * marketing sends Omnisend replaces, so they never consult this. Back-in-stock
 * alerts and the coupon-announcement broadcast keep working too — Omnisend
 * cannot do back-in-stock for an API store, and the owner may still want the
 * one-off broadcast.
 *
 * Deliberately NOT server-only: it reads nothing secret and holds no client,
 * so the cron route, the admin routes and their tests can all import it
 * without stubbing a module wall.
 */

/** The logged reason, verbatim from the spec, wherever a sender stands down. */
export const MARKETING_OWNED_BY_OMNISEND = "marketing owned by omnisend";

/**
 * Why an in-house marketing send must not go, or null when it may.
 *
 * Returns the reason rather than a boolean so callers log or answer with the
 * one phrase, instead of each inventing its own.
 */
export function marketingSendBlockedByOmnisend(env: NodeJS.ProcessEnv = process.env): string | null {
  return omnisendOwnsMarketing(env) ? MARKETING_OWNED_BY_OMNISEND : null;
}
