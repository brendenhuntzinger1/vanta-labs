/**
 * Purchase send-ledger — per-platform deduplication.
 *
 * `ad_purchase_events_sent` records that an order's Purchase has been reported
 * server-side, so a confirmation link re-opened after a platform's own dedup
 * window closes cannot create a second conversion.
 *
 * It was originally keyed on `order_id` alone, which is one ledger shared by
 * every channel: the first platform to write a row silenced all the others for
 * that order, permanently. TikTok delivering meant Reddit could never report
 * that sale. The key is now (order_id, platform) — see
 * `ads-purchase-ledger-per-platform.sql` — and this module is the read side of
 * that change.
 *
 * Pure and database-free on purpose: the route reads every row for the order in
 * one query and asks this helper, per platform, whether that channel has
 * already reported. Note what this does NOT do — it does not make sends
 * exactly-once by itself. Two simultaneous requests can both read "not sent";
 * only the database's unique constraint on (order_id, platform) stops both
 * from inserting.
 */

/** Channels that write to the purchase send-ledger. */
export type LedgerPlatform = "tiktok" | "reddit" | "google";

/** The subset of an `ad_purchase_events_sent` row this decision needs. */
export type LedgerRow = {
  order_id?: string | null;
  /**
   * Nullable and widened to `string` deliberately: the column has
   * `default 'tiktok'` but is read back from PostgREST, and a row written
   * before the column existed — or by a channel this build does not know about
   * — must not be able to crash or silently suppress a send.
   */
  platform?: string | null;
  delivered?: boolean | null;
};

/**
 * Rows with no platform are charged to TikTok, matching the column default
 * under which they were written. Anything else would let a legacy row either
 * suppress every channel or suppress none.
 */
function platformOf(row: LedgerRow): string {
  const raw = String(row?.platform ?? "").trim().toLowerCase();
  return raw === "" ? "tiktok" : raw;
}

/**
 * Has `platform` already reported this order?
 *
 * `delivered` is deliberately not consulted: a row exists once a send has been
 * attempted, and a hard platform rejection must not be retried on every page
 * refresh. The row's presence is the fact; `delivered` is only for later
 * repair.
 */
export function wasAlreadySent(rows: readonly LedgerRow[] | null | undefined, platform: LedgerPlatform): boolean {
  if (!rows) return false;
  const wanted = platform.trim().toLowerCase();
  return rows.some((row) => platformOf(row) === wanted);
}

/**
 * The marker `ads-purchase-ledger-per-platform.sql` writes on the rows it
 * backfills. Those rows were NEVER sent: they exist only so an order that
 * predates the per-platform key cannot newly report on a channel the old
 * single-column key had silenced. Anything that counts sends must skip them.
 */
export const BACKFILL_EVENT_ID = "backfill-no-send";

/** A ledger row as the health reader sees it — `event_id` included. */
export type LedgerCountRow = LedgerRow & { event_id?: string | null };

/** The shape the tracking-health board consumes. */
export type LedgerCounts = { available: boolean; total: number; delivered: number };

/** Is this row a suppression marker rather than a record of a real send? */
export function isBackfillRow(row: LedgerCountRow): boolean {
  return String(row?.event_id ?? "").trim().toLowerCase() === BACKFILL_EVENT_ID;
}

/**
 * How many Purchase events one platform genuinely attempted, and how many it
 * had accepted.
 *
 * Pure, so the health board's arithmetic is testable without a database. Two
 * classes of row must not be counted towards a platform's card: another
 * platform's rows, and this migration's suppression rows. Counting either would
 * make the TikTok card claim sends it never made — and worse, on an account
 * with no delivered TikTok row, a non-zero total flips that check from
 * NOT_TESTED to FAIL, reporting a green integration as broken.
 */
export function countLedger(
  rows: readonly LedgerCountRow[] | null | undefined,
  platform: LedgerPlatform = "tiktok",
): LedgerCounts {
  if (!rows) return { available: false, total: 0, delivered: 0 };
  const wanted = platform.trim().toLowerCase();
  const genuine = rows.filter((row) => platformOf(row) === wanted && !isBackfillRow(row));
  return {
    available: true,
    total: genuine.length,
    delivered: genuine.filter((row) => Boolean(row?.delivered)).length,
  };
}
