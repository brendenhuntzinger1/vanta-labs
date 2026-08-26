/**
 * A stand-in for `supabaseAdmin.from("orders").update(...)` that behaves the way
 * Postgres actually does.
 *
 * The shipping writes are compare-and-swap: they carry an `.eq("fulfillment_status",
 * <the value the decision was made against>)` so a stale decision cannot overwrite a
 * newer one, and they read back the affected rows to learn whether they won.
 *
 * A double whose `.eq()` returns a resolved promise cannot express either half of
 * that — it applies every write unconditionally and reports nothing — so it would
 * pass whether or not the guard exists. This one holds the predicates, applies the
 * write ONLY while they still match, and returns the rows it touched.
 */
export interface OrdersUpdateDoubleOptions {
  /**
   * The targeted row's fulfillment_status as it stands right now, read at commit
   * time. Receives the predicates so a double holding several orders can find the
   * one this write is aimed at.
   */
  currentStatus: (predicates: Record<string, unknown>) => string | null | undefined;
  /** Called only when the write actually applied. */
  onCommit: (payload: Record<string, unknown>, predicates: Record<string, unknown>) => void;
}

export function ordersUpdateDouble(options: OrdersUpdateDoubleOptions) {
  return (payload: Record<string, unknown>) => {
    const predicates: Record<string, unknown> = {};

    const commit = (): { data: unknown[]; error: null } => {
      if (Object.prototype.hasOwnProperty.call(predicates, "fulfillment_status")) {
        const expected = predicates.fulfillment_status;
        const actual = options.currentStatus(predicates) ?? null;
        // `.is("fulfillment_status", null)` arrives here as an explicit null.
        if ((expected ?? null) !== actual) {
          return { data: [], error: null };
        }
      }
      options.onCommit(payload, predicates);
      return { data: [{ order_id: predicates.order_id ?? null }], error: null };
    };

    const builder: Record<string, unknown> = {
      eq(column: string, value: unknown) {
        predicates[column] = value;
        return builder;
      },
      is(column: string, value: unknown) {
        predicates[column] = value;
        return builder;
      },
      select() {
        return builder;
      },
      then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
        return Promise.resolve(commit()).then(resolve);
      },
    };

    return builder;
  };
}
