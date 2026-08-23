/**
 * An in-memory stand-in for the Supabase client, built for END-TO-END
 * certification rather than for unit tests.
 *
 * WHY THIS EXISTS
 *
 * Every prior suite mocks `@/lib/supabase-server` per-file with a hand-written
 * object that answers exactly the two or three queries that one module makes.
 * That proves a module in isolation and proves nothing about the SEAMS between
 * modules — which is where the defects in this codebase have always been.
 *
 * This module is different: it is one database that every module in the journey
 * shares. Checkout writes an order; the payment webhook reads that same row;
 * the Shippo push reads what the webhook wrote; the tracking webhook reads what
 * the push wrote; the profit reconciliation reads all of it. Nothing is handed
 * between steps by the test — the only channel is the database, exactly as in
 * production.
 *
 * WHAT IT MODELS FAITHFULLY (the parts the guards depend on)
 *
 *   • PRIMARY KEY violations return Postgres error code 23505. Three separate
 *     idempotency guards (payment_events.event_id, shippo_webhook_events
 *     .event_key, the derived replacement order_id) are built on exactly that,
 *     so a fake that silently accepts a duplicate would make them all look
 *     correct while proving nothing.
 *   • Conditional UPDATE ... WHERE returns the rows it actually matched, so the
 *     claim pattern (`.is(col, null).select("id")` → won/lost) behaves as it
 *     does in Postgres. This is the single mechanism behind exactly-once paid
 *     side-effects, the label-purchase claim, the Shippo sync claim and the
 *     restock claim.
 *   • An UNFILTERED select returns a row, because Postgres would. A matcher
 *     that gives up and grabs the nearest order must look WRONG here, not
 *     right.
 *   • The inventory RPCs move real numbers, so reserve → finalize → restock is
 *     arithmetic rather than assertion.
 *
 * WHAT IT DELIBERATELY DOES NOT MODEL: RLS, triggers, transactions, and SQL
 * CHECK constraints. Those are certified separately against the migrations; a
 * fake that claimed to enforce them would be evidence of nothing.
 */

export type Row = Record<string, unknown>;

interface Filter {
  kind: "eq" | "neq" | "is" | "in" | "gt" | "gte" | "lt" | "lte" | "not_in" | "not_is" | "like";
  column: string;
  value: unknown;
}

/** Columns that behave as a PRIMARY KEY / UNIQUE index, by table. */
const UNIQUE_KEYS: Record<string, string[]> = {
  orders: ["order_id"],
  payment_events: ["event_id"],
  shippo_webhook_events: ["event_key"],
  referral_orders: ["order_id"],
  order_shipments: ["order_id"],
  inventory_reservations: [],
};

function matches(row: Row, filter: Filter): boolean {
  const actual = row[filter.column];
  switch (filter.kind) {
    case "eq":
      // Supabase compares as text over the wire for most scalar columns; the
      // loose compare keeps `1` and `"1"` equivalent the way PostgREST does.
      return String(actual ?? "") === String(filter.value ?? "") && actual != null;
    case "neq":
      return String(actual ?? "") !== String(filter.value ?? "");
    case "is":
      return filter.value === null ? actual == null : actual === filter.value;
    case "not_is":
      return filter.value === null ? actual != null : actual !== filter.value;
    case "in":
      return (filter.value as unknown[]).map(String).includes(String(actual ?? ""));
    case "not_in":
      return !(filter.value as unknown[]).map(String).includes(String(actual ?? ""));
    case "gt":
      return actual != null && String(actual) > String(filter.value);
    case "gte":
      return actual != null && String(actual) >= String(filter.value);
    case "lt":
      return actual != null && String(actual) < String(filter.value);
    case "lte":
      return actual != null && String(actual) <= String(filter.value);
    case "like":
      return String(actual ?? "").includes(String(filter.value).replaceAll("%", ""));
    default:
      return true;
  }
}

export interface FakeDbFailure {
  /** Table the failure applies to. */
  table: string;
  /** Operation to fail: "insert" | "update" | "select" | "delete" | "upsert". */
  op: string;
  /** How many times to fail before healing. */
  times: number;
  message?: string;
}

/**
 * The database view that resolves the newest control write per (section, key).
 * Modelled here because it is the mechanism under test: a fake that answered
 * from raw history would prove nothing about the fix.
 */
export const CONTROL_VIEW = "admin_control_current";

export class FakeDb {
  readonly tables = new Map<string, Row[]>();
  /**
   * Set true to simulate a database where admin-control-current-view.sql has
   * NOT been applied, so the reader's fallback path is exercised.
   */
  controlViewMissing = false;
  /** Every write, in order — the audit trail a crash test replays against. */
  readonly writeLog: Array<{ table: string; op: string; payload?: unknown }> = [];
  private failures: FakeDbFailure[] = [];
  private idCounter = 0;

  table(name: string): Row[] {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }

  seed(name: string, rows: Row[]): void {
    this.table(name).push(...rows.map((row) => ({ ...row })));
  }

  /** Rows currently in a table (copies, so a test cannot mutate the db by accident). */
  rows(name: string): Row[] {
    return this.table(name).map((row) => ({ ...row }));
  }

  findOne(name: string, column: string, value: unknown): Row | null {
    const found = this.table(name).find((row) => String(row[column] ?? "") === String(value));
    return found ? { ...found } : null;
  }

  /**
   * `select distinct on (target_table, target_id) ... order by created_at desc`
   * — the newest control write per key, exactly as the SQL view computes it.
   *
   * Returns nothing when the view is simulated absent, which is how a database
   * missing the migration behaves from the reader's point of view.
   */
  controlCurrentRows(): Row[] {
    if (this.controlViewMissing) return [];
    const newest = new Map<string, Row>();
    for (const row of this.table("admin_audit_logs")) {
      if (row.action !== "admin_control_upsert") continue;
      if (row.target_table == null || row.target_id == null) continue;
      const key = `${row.target_table}::${row.target_id}`;
      const existing = newest.get(key);
      if (!existing || String(row.created_at ?? "") > String(existing.created_at ?? "")) {
        newest.set(key, row);
      }
    }
    return [...newest.values()].map((row) => ({ ...row }));
  }

  /**
   * Make the next `times` operations of this shape fail, the way a database
   * under load or a killed process does. Used to inject a failure BETWEEN two
   * writes and prove the system recovers rather than stranding an order.
   */
  injectFailure(failure: FakeDbFailure): void {
    this.failures.push({ ...failure });
  }

  clearFailures(): void {
    this.failures = [];
  }

  private takeFailure(table: string, op: string): { code: string; message: string } | null {
    const hit = this.failures.find((f) => f.table === table && f.op === op && f.times > 0);
    if (!hit) return null;
    hit.times -= 1;
    return { code: "XX000", message: hit.message ?? `injected ${op} failure on ${table}` };
  }

  private violatesUnique(table: string, row: Row): boolean {
    const keys = UNIQUE_KEYS[table];
    if (!keys || keys.length === 0) return false;
    return this.table(table).some((existing) =>
      keys.every((key) => row[key] != null && String(existing[key] ?? "") === String(row[key])),
    );
  }

  // ---------------------------------------------------------------- client --

  get client() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const db = this;

    function selectBuilder(table: string, columns?: string) {
      const filters: Filter[] = [];
      // PostgREST embeds: `select("*, order_items(*)")` returns the child rows
      // nested on each parent. The replacement workflow reads its original
      // order this way, so a fake that ignored it would hand that code an order
      // with no items — and it would ship an empty parcel rather than fail.
      const embeds = [...String(columns ?? "").matchAll(/([a-z_]+)\s*\(/g)]
        .map((match) => match[1])
        .filter((name) => name !== "count");
      let limitCount: number | null = null;
      let orderColumn: string | null = null;
      let ascending = true;

      const run = () => {
        const failure = db.takeFailure(table, "select");
        if (failure) return { data: null, error: failure };
        if (table === CONTROL_VIEW && db.controlViewMissing) {
          // Exactly how PostgREST answers a database that has not had
          // admin-control-current-view.sql applied.
          return { data: null, error: { code: "42P01", message: `relation "public.${CONTROL_VIEW}" does not exist` } };
        }
        const source = table === CONTROL_VIEW ? db.controlCurrentRows() : db.table(table);
        let rows = source.filter((row) => filters.every((f) => matches(row, f)));
        if (orderColumn) {
          const column = orderColumn;
          rows = [...rows].sort((a, b) => {
            const av = String(a[column] ?? "");
            const bv = String(b[column] ?? "");
            return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
          });
        }
        if (limitCount != null) rows = rows.slice(0, limitCount);
        const projected = rows.map((row) => {
          const copy: Row = { ...row };
          for (const embed of embeds) {
            copy[embed] = db.table(embed)
              .filter((child) => String(child.order_id ?? "") === String(row.order_id ?? ""))
              .map((child) => ({ ...child }));
          }
          return copy;
        });
        return { data: projected, error: null };
      };

      const builder: Record<string, unknown> = {
        eq(column: string, value: unknown) { filters.push({ kind: "eq", column, value }); return builder; },
        neq(column: string, value: unknown) { filters.push({ kind: "neq", column, value }); return builder; },
        is(column: string, value: unknown) { filters.push({ kind: "is", column, value }); return builder; },
        in(column: string, value: unknown[]) { filters.push({ kind: "in", column, value }); return builder; },
        gt(column: string, value: unknown) { filters.push({ kind: "gt", column, value }); return builder; },
        gte(column: string, value: unknown) { filters.push({ kind: "gte", column, value }); return builder; },
        lt(column: string, value: unknown) { filters.push({ kind: "lt", column, value }); return builder; },
        lte(column: string, value: unknown) { filters.push({ kind: "lte", column, value }); return builder; },
        like(column: string, value: unknown) { filters.push({ kind: "like", column, value }); return builder; },
        ilike(column: string, value: unknown) { filters.push({ kind: "like", column, value }); return builder; },
        // PostgREST spells negation as .not(col, op, value); the two forms the
        // application actually uses are `not(col,"in","(a,b)")` and
        // `not(col,"is",null)`.
        not(column: string, op: string, value: unknown) {
          if (op === "in") {
            const list = String(value).replace(/^\(|\)$/g, "").split(",").map((part) => part.trim());
            filters.push({ kind: "not_in", column, value: list });
          } else if (op === "is") {
            filters.push({ kind: "not_is", column, value: value === "null" ? null : value });
          }
          return builder;
        },
        order(column: string, opts?: { ascending?: boolean }) {
          orderColumn = column;
          ascending = opts?.ascending !== false;
          return builder;
        },
        limit(count: number) { limitCount = count; return builder; },
        range() { return builder; },
        async maybeSingle() {
          const result = run();
          if (result.error) return { data: null, error: result.error };
          return { data: result.data?.[0] ?? null, error: null };
        },
        async single() {
          const result = run();
          if (result.error) return { data: null, error: result.error };
          if (!result.data || result.data.length === 0) {
            return { data: null, error: { code: "PGRST116", message: "no rows returned" } };
          }
          return { data: result.data[0], error: null };
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          try {
            return Promise.resolve(run()).then(resolve, reject);
          } catch (error) {
            return Promise.reject(error).then(resolve, reject);
          }
        },
      };
      return builder;
    }

    function tableClient(table: string) {
      return {
        select: (columns?: string) => selectBuilder(table, columns),

        insert(payload: Row | Row[]) {
          const rows = (Array.isArray(payload) ? payload : [payload]).map((row) => ({ ...row }));
          const apply = () => {
            const failure = db.takeFailure(table, "insert");
            if (failure) return { data: null, error: failure };
            for (const row of rows) {
              if (db.violatesUnique(table, row)) {
                return {
                  data: null,
                  error: { code: "23505", message: `duplicate key value violates unique constraint on ${table}` },
                };
              }
            }
            for (const row of rows) {
              if (row.id == null) row.id = `${table}-${++db.idCounter}`;
              db.table(table).push(row);
              db.writeLog.push({ table, op: "insert", payload: row });
            }
            return { data: rows.map((row) => ({ ...row })), error: null };
          };

          const builder: Record<string, unknown> = {
            select: () => ({
              async single() {
                const result = apply();
                if (result.error) return { data: null, error: result.error };
                return { data: result.data?.[0] ?? null, error: null };
              },
              async maybeSingle() {
                const result = apply();
                if (result.error) return { data: null, error: result.error };
                return { data: result.data?.[0] ?? null, error: null };
              },
              then(resolve: (value: unknown) => unknown) { return Promise.resolve(apply()).then(resolve); },
            }),
            then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
              return Promise.resolve(apply()).then(resolve, reject);
            },
          };
          return builder;
        },

        update(payload: Row) {
          const filters: Filter[] = [];
          const apply = () => {
            const failure = db.takeFailure(table, "update");
            if (failure) return { data: null, error: failure };
            const target = db.table(table).filter((row) => filters.every((f) => matches(row, f)));
            for (const row of target) Object.assign(row, payload);
            if (target.length > 0) db.writeLog.push({ table, op: "update", payload });
            // Postgres returns the rows the WHERE actually matched — the entire
            // basis of the claim pattern.
            return { data: target.map((row) => ({ ...row })), error: null };
          };

          const builder: Record<string, unknown> = {
            eq(column: string, value: unknown) { filters.push({ kind: "eq", column, value }); return builder; },
            neq(column: string, value: unknown) { filters.push({ kind: "neq", column, value }); return builder; },
            is(column: string, value: unknown) { filters.push({ kind: "is", column, value }); return builder; },
            in(column: string, value: unknown[]) { filters.push({ kind: "in", column, value }); return builder; },
            gt(column: string, value: unknown) { filters.push({ kind: "gt", column, value }); return builder; },
            lt(column: string, value: unknown) { filters.push({ kind: "lt", column, value }); return builder; },
            not(column: string, op: string, value: unknown) {
              if (op === "is") filters.push({ kind: "not_is", column, value: value === "null" ? null : value });
              return builder;
            },
            select: () => apply(),
            then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
              return Promise.resolve(apply()).then(resolve, reject);
            },
          };
          return builder;
        },

        async upsert(payload: Row | Row[], options?: { onConflict?: string }) {
          const failure = db.takeFailure(table, "upsert");
          if (failure) return { data: null, error: failure };
          const rows = Array.isArray(payload) ? payload : [payload];
          const keys = options?.onConflict
            ? options.onConflict.split(",").map((key) => key.trim())
            : UNIQUE_KEYS[table] ?? [];
          for (const row of rows) {
            const existing = keys.length
              ? db.table(table).find((candidate) =>
                  keys.every((key) => String(candidate[key] ?? "") === String(row[key] ?? "")))
              : undefined;
            if (existing) {
              Object.assign(existing, row);
            } else {
              db.table(table).push({ id: `${table}-${++db.idCounter}`, ...row });
            }
            db.writeLog.push({ table, op: "upsert", payload: row });
          }
          return { data: null, error: null };
        },

        delete() {
          const filters: Filter[] = [];
          const apply = () => {
            const failure = db.takeFailure(table, "delete");
            if (failure) return { data: null, error: failure };
            const remaining: Row[] = [];
            const removed: Row[] = [];
            for (const row of db.table(table)) {
              (filters.every((f) => matches(row, f)) ? removed : remaining).push(row);
            }
            db.tables.set(table, remaining);
            if (removed.length) db.writeLog.push({ table, op: "delete" });
            return { data: removed, error: null };
          };
          const builder: Record<string, unknown> = {
            eq(column: string, value: unknown) { filters.push({ kind: "eq", column, value }); return builder; },
            is(column: string, value: unknown) { filters.push({ kind: "is", column, value }); return builder; },
            in(column: string, value: unknown[]) { filters.push({ kind: "in", column, value }); return builder; },
            lt(column: string, value: unknown) { filters.push({ kind: "lt", column, value }); return builder; },
            then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
              return Promise.resolve(apply()).then(resolve, reject);
            },
          };
          return builder;
        },
      };
    }

    return {
      from: (table: string) => tableClient(table),
      rpc: async (name: string, args: Record<string, unknown> = {}) => db.rpc(name, args),
      auth: {
        getUser: async () => ({ data: { user: null }, error: null }),
        admin: {
          getUserById: async () => ({ data: { user: null }, error: null }),
          inviteUserByEmail: async () => ({ data: null, error: null }),
        },
      },
    };
  }

  // ------------------------------------------------------------------ rpcs --

  /**
   * The stored procedures, implemented so inventory is ARITHMETIC rather than
   * assertion. `reserve_inventory` in particular is the store's only real
   * oversell guard, so it models the same all-or-nothing availability check the
   * SQL performs under a row lock.
   */
  private async rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> {
    const failure = this.takeFailure(`rpc:${name}`, "rpc");
    if (failure) return { data: null, error: failure };

    const stockRow = (slug: unknown, variantId: unknown): Row | undefined => {
      if (variantId) return this.table("product_doses").find((row) => String(row.id) === String(variantId));
      return this.table("products").find((row) => String(row.slug) === String(slug));
    };

    switch (name) {
      case "reserve_inventory": {
        const row = stockRow(args.p_slug, args.p_variant_id);
        // An untracked item (no stock row) is allowed through, matching the SQL:
        // the guard governs tracked stock only.
        if (!row) return { data: null, error: null };
        const quantity = Number(args.p_quantity ?? 0);
        const existing = this.table("inventory_reservations").find(
          (res) => String(res.order_id) === String(args.p_order_id)
            && String(res.slug) === String(args.p_slug)
            && String(res.variant_id ?? "") === String(args.p_variant_id ?? "")
            && res.status === "active",
        );
        // Idempotent per order: a refresh or retry never double-holds.
        if (existing) return { data: true, error: null };
        const available = Number(row.inventory_quantity ?? 0) - Number(row.reserved_quantity ?? 0);
        if (available < quantity) return { data: false, error: null };
        row.reserved_quantity = Number(row.reserved_quantity ?? 0) + quantity;
        this.table("inventory_reservations").push({
          id: `res-${++this.idCounter}`,
          order_id: args.p_order_id,
          slug: args.p_slug,
          variant_id: args.p_variant_id ?? null,
          quantity,
          status: "active",
          expires_at: args.p_expires_at,
        });
        return { data: true, error: null };
      }

      case "finalize_inventory_for_order": {
        let finalized = 0;
        for (const res of this.table("inventory_reservations")) {
          if (String(res.order_id) !== String(args.p_order_id) || res.status !== "active") continue;
          const row = stockRow(res.slug, res.variant_id);
          if (row) {
            row.reserved_quantity = Number(row.reserved_quantity ?? 0) - Number(res.quantity ?? 0);
            row.inventory_quantity = Number(row.inventory_quantity ?? 0) - Number(res.quantity ?? 0);
          }
          res.status = "finalized";
          finalized += 1;
        }
        return { data: finalized, error: null };
      }

      case "release_inventory_for_order": {
        for (const res of this.table("inventory_reservations")) {
          if (String(res.order_id) !== String(args.p_order_id) || res.status !== "active") continue;
          const row = stockRow(res.slug, res.variant_id);
          if (row) row.reserved_quantity = Number(row.reserved_quantity ?? 0) - Number(res.quantity ?? 0);
          res.status = "released";
        }
        return { data: null, error: null };
      }

      case "expire_stale_reservations": {
        const now = new Date().toISOString();
        let reclaimed = 0;
        for (const res of this.table("inventory_reservations")) {
          if (res.status !== "active") continue;
          if (String(res.expires_at ?? "") >= now) continue;
          const row = stockRow(res.slug, res.variant_id);
          if (row) row.reserved_quantity = Number(row.reserved_quantity ?? 0) - Number(res.quantity ?? 0);
          res.status = "expired";
          reclaimed += 1;
        }
        return { data: reclaimed, error: null };
      }

      case "adjust_inventory_on_sale": {
        const row = stockRow(args.p_slug, args.p_variant_id);
        if (!row) return { data: null, error: null };
        const next = Number(row.inventory_quantity ?? 0) + Number(args.p_qty ?? 0);
        // The SQL refuses to drive stock negative; a decrement that cannot apply
        // is a no-op rather than a phantom unit.
        if (next < 0) return { data: null, error: null };
        row.inventory_quantity = next;
        return { data: null, error: null };
      }

      case "redeem_coupon": {
        const coupon = this.table("coupons").find(
          (row) => String(row.code ?? "").toUpperCase() === String(args.p_code ?? "").toUpperCase(),
        );
        if (coupon) coupon.times_redeemed = Number(coupon.times_redeemed ?? 0) + 1;
        return { data: null, error: null };
      }

      default:
        return { data: null, error: null };
    }
  }
}

export function createFakeDb(): FakeDb {
  return new FakeDb();
}
