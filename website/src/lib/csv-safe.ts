/**
 * ONE CSV cell escaper, for every export in the app.
 *
 * This codebase had EIGHT. Four neutralise spreadsheet formula injection and
 * four only quote:
 *
 *   GUARDED    api/admin/orders/export/route.ts   csvEscape
 *              lib/admin-customers.ts             csvEscape
 *              lib/admin-membership.ts            csvEscape
 *              lib/inventory-ledger.ts            csvCell
 *
 *   UNGUARDED  api/admin/partners/export-payouts/route.ts
 *              api/admin/partners/export-payout-history/route.ts
 *              api/admin/tax/export/route.ts
 *              lib/admin-products-csv.ts
 *
 * WHY QUOTING IS NOT THE DEFENCE
 *
 * Wrapping a cell in double quotes stops DELIMITER injection -- a comma or a
 * newline breaking the row apart. It does nothing about FORMULA injection:
 * Excel and Sheets strip the surrounding quotes while parsing the field and
 * then evaluate a leading `=`. The two bugs look similar and only one of them
 * is fixed by quoting.
 *
 * A leading apostrophe is what marks a cell as literal text, so it is added
 * BEFORE the quoting decision.
 *
 * This matters most where the text is not the operator's own: a partner's name,
 * email and referral code come from the PUBLIC ambassador application form, so
 * they are unauthenticated attacker-controlled input that lands in a file the
 * owner opens in a spreadsheet.
 *
 * Behaviour is byte-for-byte identical to the four that already got this right,
 * so adopting it changes no existing export's output.
 */

/** Characters a spreadsheet treats as the start of a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Characters that require the cell to be quoted. */
const NEEDS_QUOTING = /[",\n]/;

export function csvSafeCell(value: unknown): string {
  let text = String(value ?? "");

  // Guard FIRST. A cell can need both treatments, and the apostrophe has to sit
  // inside the quotes to be seen by the spreadsheet.
  if (FORMULA_START.test(text)) {
    text = `'${text}`;
  }

  if (NEEDS_QUOTING.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}
