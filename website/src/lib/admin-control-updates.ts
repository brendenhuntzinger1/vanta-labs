// ---------------------------------------------------------------------------
// WHAT A CONTROL-CENTER SAVE IS ALLOWED TO WRITE.
//
// Deliberately dependency-free (no `server-only`, no database) so the SAME two
// rules run on the client that builds the request and on the route that
// accepts it. A settings wipe has to get past both.
//
// It exists because it already happened. The Control Center renders ~30 fields
// from one snapshot fetch behind a single Save button that PATCHed all of them
// unconditionally. Every field initialises blank, and a failed load only set a
// message -- it left the button live over an empty form. Four saves in the
// audit history wrote "" across the board; the one on 2026-08-15 took
// tax.nexus_states from 48 states to empty, and an empty nexus list means
// resolveSalesTax() returns zero tax for every order in every state.
//
//   RULE 1  An unloaded form cannot write. No snapshot, no updates.
//   RULE 2  A save carries only what changed, and emptying a populated setting
//           is an explicit act that must announce itself.
// ---------------------------------------------------------------------------

export interface ControlUpdate {
  section: string;
  key: string;
  value: unknown;
  /**
   * Set only when the operator is deliberately emptying a setting that
   * currently holds a value. Without it the server refuses the write, so a
   * blank that arrived by accident -- an unloaded form, a stale tab, a caller
   * that forgot to read first -- cannot erase live configuration.
   */
  allowClear?: boolean;
}

/**
 * Blank means "the operator left this empty", which the settings readers treat
 * as "fall back to the default".
 *
 * `false` and `0` are NOT blank. They are real, chosen values -- a disabled
 * toggle, a zero threshold -- and treating them as absent would silently
 * restore whatever default they were set to override.
 */
export function isBlankControlValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value.trim() === "";
}

/**
 * Stored values come back from the settings store as strings; the form holds
 * real booleans and numbers. Comparing across that boundary without
 * normalising reports every boolean as "changed" on every save -- which is how
 * one click produced thirty audit rows and buried the real edit among them.
 */
function normalizeForComparison(value: unknown): string {
  if (isBlankControlValue(value)) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value).trim();
}

function pathOf(update: Pick<ControlUpdate, "section" | "key">): string {
  return `${update.section}.${update.key}`;
}

/**
 * RULE 1 + RULE 2, applied where the request is built.
 *
 * `baseline` is the snapshot the form was populated from, keyed "section.key".
 * Anything the operator did not move is dropped, so the audit log records the
 * edit rather than the form.
 */
export function buildControlUpdates(input: {
  loaded: boolean;
  desired: ControlUpdate[];
  baseline: Record<string, unknown>;
}): ControlUpdate[] {
  // RULE 1. The form's pristine state is indistinguishable from "the operator
  // cleared everything", so until a snapshot has actually landed there is no
  // safe interpretation of it and nothing may be written.
  if (!input.loaded) return [];

  const updates: ControlUpdate[] = [];

  for (const update of input.desired) {
    const stored = input.baseline[pathOf(update)];
    const before = normalizeForComparison(stored);
    const after = normalizeForComparison(update.value);

    if (before === after) continue;

    // Emptying something that held a value is the destructive case. Mark it so
    // the server can tell a deliberate clear from an accidental one.
    if (after === "" && before !== "") {
      updates.push({ section: update.section, key: update.key, value: update.value, allowClear: true });
      continue;
    }

    updates.push({ section: update.section, key: update.key, value: update.value });
  }

  return updates;
}

/**
 * RULE 2, applied again where the request is accepted.
 *
 * Returns the "section.key" paths that would empty a currently-populated
 * setting without saying so. A non-empty result means the request must be
 * refused in full -- rejecting before any write is what keeps a partial save
 * from leaving settings half-wiped.
 *
 * `stored` is the shape getControlSnapshot() returns: section -> key -> value.
 */
export function findDestructiveClears(
  updates: ControlUpdate[],
  stored: Record<string, Record<string, unknown>>,
): string[] {
  const destructive: string[] = [];

  for (const update of updates) {
    if (update.allowClear) continue;
    if (!isBlankControlValue(update.value)) continue;

    const current = stored[update.section]?.[update.key];
    if (isBlankControlValue(current)) continue;

    destructive.push(pathOf(update));
  }

  return destructive;
}
