// ---------------------------------------------------------------------------
// STORE SETTINGS A SUITE DEPENDS ON, STATED BY THAT SUITE.
//
// Control Center values live in admin_audit_logs and resolve newest-row-wins
// through the admin_control_current view, so a suite that writes one is
// changing the STORE for everything that runs after it. qa-cart-recovery-override
// turns `shipping.free_shipping_sitewide` on — correctly, because production
// runs it that way and its totals depend on it — and never turned it back off.
// qa-customer-offer proves a free-SHIPPING gift, which needs shipping to cost
// something, and read whatever the last suite happened to leave:
//
//     FAIL  an ordinary order pays shipping, so the gift has something to give
//           baseline order already shipped free (0.00)
//     FAIL  a stranger cannot spend somebody else's shipping gift
//           a different address got free shipping
//
// Seven failures, every one of them the store obeying a setting the file never
// asked for, in a file that had passed minutes earlier. That is the most
// expensive kind of false red: the evidence points away from the cause.
//
// So: capture before, pin what you need, restore at the end. The same shape as
// qa-automation-fixtures.mjs, and for the same reason.
//
//   const before = await captureControl(q, [["shipping", "free_shipping_sitewide"]]);
//   await pinControl(q, [["shipping", "free_shipping_sitewide", false]]);
//   ...
//   await restoreControl(q, before);
// ---------------------------------------------------------------------------

/**
 * What the store currently says for each (section, key).
 *
 * `value: null` means no row exists yet — the coded default stands. Restoring
 * that case writes the default back explicitly rather than deleting audit rows:
 * this is an append-only log, and for every key here an explicit default and an
 * absent row resolve identically (`=== true` for the booleans, "blank means the
 * coded default" for the numbers).
 */
export async function captureControl(q, pairs) {
  const captured = [];
  for (const [section, key] of pairs) {
    const { rows } = await q(
      `select metadata->'value' as value
         from admin_control_current
        where target_table = $1 and target_id = $2
        limit 1`,
      [section, key],
    );
    captured.push({ section, key, value: rows[0] ? rows[0].value : null });
  }
  return captured;
}

/**
 * The running app's control-snapshot cache, from control-snapshot-cache.ts.
 *
 * Writing the row is not the same as the store reading it: getControlSnapshot
 * caches for ten seconds, so a suite that pins a setting and opens a page a
 * second later is served the OLD value. qa-offer-checkout-journey did exactly
 * that in one shuffled batch and failed its very first check with
 * "cart total 59, expected 74.00 ($59 + $15 shipping)" — the pin was correct
 * and the shop had simply not noticed it yet. The suites that happened to do a
 * lot of seeding before their first page load never saw it, which is what makes
 * this the kind of race that only shows up in one order out of four.
 */
const CONTROL_SNAPSHOT_TTL_MS = 10_000;

/**
 * Say what the store is, for the length of this suite, and WAIT FOR IT TO TAKE.
 *
 * The settle is the cache window plus a second. Pass `settleMs: 0` only where
 * nothing reads the setting through the app.
 */
export async function pinControl(q, triples, { settleMs = CONTROL_SNAPSHOT_TTL_MS + 1000 } = {}) {
  for (const [section, key, value] of triples) {
    await q(
      `insert into admin_audit_logs (action, target_table, target_id, metadata, created_at)
       values ('admin_control_upsert', $1, $2, $3, now())`,
      [section, key, JSON.stringify({ value })],
    );
  }
  if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
}

/**
 * Put the store back, so the next suite reads what it read before this one ran.
 *
 * Never throws: a restore that fails mid-teardown must not turn a passing run
 * into a failing one, and the next suite's own pin is the real guard.
 */
export async function restoreControl(q, captured) {
  for (const entry of captured ?? []) {
    await q(
      `insert into admin_audit_logs (action, target_table, target_id, metadata, created_at)
       values ('admin_control_upsert', $1, $2, $3, now())`,
      [entry.section, entry.key, JSON.stringify({ value: entry.value })],
    ).catch(() => {});
  }
}
