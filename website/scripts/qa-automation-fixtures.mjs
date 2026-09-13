/**
 * THE AUTOMATION TABLE IS SHARED, AND FOUR SUITES WERE EDITING IT IN PLACE.
 *
 * `email_automations` holds one row per lifecycle flow: whether it is enabled,
 * its delay, and — the expensive one — which offer it carries. Four suites set
 * those to exercise a gift, and none of them put anything back. The next suite
 * to run then met a store it never configured:
 *
 *     qa-retention-system attaches a free-shipping gift to `replenishment`
 *       -> qa-lifecycle-email's reorder reminder is WITHHELD, because its
 *          subscriber has no account and a gift has nowhere to be redeemed
 *       -> reported as "expected the reminder, got 0", which reads like a dead
 *          replenishment flow and is nothing of the kind
 *     the same leak reaches qa-automation-truth as
 *       "sweep errors: replenishment: withheld 1 gift-bearing message(s)"
 *
 * Both of those are the PRODUCT BEHAVING CORRECTLY — a gift-bearing message to
 * somebody who cannot redeem it is rightly withheld — reported as a failure in
 * an innocent suite, which is the worst kind of evidence: it points away from
 * the cause.
 *
 * So a suite that changes this table states what it changed and puts it back.
 * captureAutomations() before, restoreAutomations() in the finally block, and
 * pinAutomations() for the rows a suite DEPENDS on, so its verdict comes from
 * its own setup rather than from whatever ran before it.
 */

const COLUMNS = "key, enabled, delay_days, offer_key";

/** Every automation row as it stands now, to be handed back to restore. */
export async function captureAutomations(q) {
  const { rows } = await q(`select ${COLUMNS} from email_automations`);
  return rows;
}

/** Put the captured rows back, exactly. Never throws — this runs in a finally. */
export async function restoreAutomations(q, rows) {
  for (const row of rows ?? []) {
    await q(
      `update email_automations set enabled = $2, delay_days = $3, offer_key = $4 where key = $1`,
      [row.key, row.enabled, row.delay_days, row.offer_key],
    ).catch(() => {});
  }
}

/**
 * Force the rows this suite depends on into a stated shape.
 *
 * `spec` is { key: { enabled?, delayDays?, offerKey? } }. offerKey: null means
 * "no gift on this flow", which is the state a suite wants when it is proving
 * the plain reminder rather than the gift — and is exactly what a leak from
 * another suite takes away.
 */
export async function pinAutomations(q, spec) {
  for (const [key, want] of Object.entries(spec)) {
    const sets = [];
    const params = [key];
    if (want.enabled !== undefined) { params.push(want.enabled); sets.push(`enabled = $${params.length}`); }
    if (want.delayDays !== undefined) { params.push(want.delayDays); sets.push(`delay_days = $${params.length}`); }
    if (want.offerKey !== undefined) { params.push(want.offerKey); sets.push(`offer_key = $${params.length}`); }
    if (!sets.length) continue;
    await q(`update email_automations set ${sets.join(", ")} where key = $1`, params);
  }
}
