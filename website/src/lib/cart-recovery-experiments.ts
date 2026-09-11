/**
 * SUBJECT-LINE EXPERIMENTS FOR CART RECOVERY.
 *
 * The programme's problem is not that its emails convert badly once opened —
 * it is that 41 messages to real customers produced one click. That is a
 * subject-line and first-impression problem before it is an offer problem, and
 * the only honest way to fix it is to find out which subject a real shopper
 * clicks rather than to guess twice.
 *
 * THREE PROPERTIES, AND EACH IS LOAD-BEARING.
 *
 * DETERMINISTIC FROM THE CART ID. No random draw, no stored assignment, no
 * extra read. The same cart resolves to the same variant on every sweep, on
 * every process, after every redeploy — which is what stops a retry, a
 * concurrent tick or a rollback from moving a cart between arms mid-experiment
 * and quietly poisoning the result.
 *
 * STABLE ACROSS THE WHOLE SEQUENCE. A cart keeps one variant for all four
 * stages. Re-drawing per stage would mean a shopper who ignored variant A at
 * stage 1 is measured under variant B at stage 3, and neither arm would then
 * describe an experience anyone actually had.
 *
 * RECORDED, NOT INFERRED. The chosen variant is written onto the send row
 * (abandoned_cart_emails.variant), because an experiment whose assignment lives
 * only in the code that made it cannot be joined to an outcome later.
 *
 * WHAT IS NOT TESTED HERE. Only the subject and preheader vary. The offer, the
 * timing, the body and the call to action are identical across arms — one axis
 * at a time, or a difference cannot be attributed to anything.
 */

/**
 * Which experiment the variant currently means. Recorded on every send row
 * (abandoned_cart_emails.experiment) so a later test on the same column can
 * never be pooled with this one. Change it when the axis changes.
 */
export const RECOVERY_EXPERIMENT_KEY = "subject-2026-09";

export const RECOVERY_VARIANTS = ["a", "b"] as const;
export type RecoveryVariant = (typeof RECOVERY_VARIANTS)[number];

/**
 * Which arm this cart is in.
 *
 * FNV-1a over the cart id. A cheap, well-distributed, dependency-free hash —
 * this is a coin toss that has to be repeatable, not a security decision, and
 * using crypto here would make the function unusable on the client without
 * buying anything.
 *
 * An empty or unusable id falls to "a", the control arm, so a cart that
 * somehow reaches this without an id is measured as the existing behaviour
 * rather than silently joining the treatment.
 */
export function recoveryVariantFor(cartId: string | null | undefined): RecoveryVariant {
  const id = String(cartId ?? "").trim();
  if (!id) return "a";
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    // FNV prime, via shifts so the whole thing stays in 32-bit integer maths.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return RECOVERY_VARIANTS[hash % RECOVERY_VARIANTS.length];
}

/**
 * Pick one of two strings by variant.
 *
 * Exists so a template reads `pickVariant(variant, control, treatment)` at the
 * point the subject is chosen, rather than growing a branch per experiment.
 */
export function pickVariant(variant: RecoveryVariant, control: string, treatment: string): string {
  return variant === "b" ? treatment : control;
}
