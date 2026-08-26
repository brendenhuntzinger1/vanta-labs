// ---------------------------------------------------------------------------
// A supabase-js-shaped client backed by a REAL Postgres.
//
// Why this exists. The financial-reporting surfaces (admin-profit,
// admin-revenue, admin-reconciliation, admin-tax-report) are read-only
// aggregations whose defects are all about WHICH ROWS THEY SEE: a row cap, a
// status filter, an order_type filter. An in-memory fake that returns whatever
// the test handed it cannot prove any of that, because the fake IS the filter
// under test. Two of these surfaces also aggregate in Postgres via RPCs
// (admin-dashboard-rollups.sql) whose SQL has never been executed by any test.
//
// So the adapter translates the exact supabase-js call shapes those modules use
// into SQL and runs them against a throwaway Postgres. It is deliberately NOT a
// general-purpose emulator: it supports only the operators the reporting code
// actually calls, and throws loudly on anything else rather than silently
// returning [] and manufacturing a false pass.
//
// FIDELITY NOTES (these matter — getting them wrong invents or hides bugs):
//   * PostgREST serialises `numeric` as a JSON number; node-pg returns a
//     string. Parsed to Number below, or every `Number(x ?? 0)` in the report
//     code would still work while `x > 0` comparisons quietly changed meaning.
//   * PostgREST serialises timestamps as ISO-8601 strings; node-pg returns a
//     Date. Returned as ISO strings, because the report code does
//     `String(paid_at) >= startOfToday` on them.
//   * `.range(a, b)` is inclusive at both ends (OFFSET a LIMIT b-a+1).
//   * Backed by a POOL, not a single connection: the reporting code fires its
//     reads through Promise.all, and a single pg Client silently serialises
//     them. A shared connection would also make an aborted statement poison
//     every sibling read.
//   * `maxRows` models PostgREST's `db-max-rows` server config: an unrequested
//     ceiling applied to EVERY select. Off by default; a test that wants to
//     demonstrate truncation sets it explicitly.
// ---------------------------------------------------------------------------

import { types as pgTypes, type Pool } from "pg";

// numeric / int8 → JS number (PostgREST does the same over JSON).
pgTypes.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pgTypes.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// timestamptz / timestamp → ISO string (PostgREST emits strings, not Dates).
const toIso = (v: string | null) => (v === null ? null : new Date(v).toISOString());
pgTypes.setTypeParser(1184, toIso);
pgTypes.setTypeParser(1114, toIso);

export interface AdapterOptions {
  /**
   * Models PostgREST's `db-max-rows`. When set, every select is capped at this
   * many rows regardless of what the caller asked for — the caller is never
   * told. Leave undefined for an uncapped source.
   */
  maxRows?: number;
  /** Every statement the adapter ran, in order. Useful for asserting caps. */
  log?: string[];
}

type Filter = { op: string; column: string; value: unknown };

interface SelectResult<T> {
  data: T[] | null;
  error: { message: string; code?: string } | null;
  count: number | null;
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

/**
 * PostgREST select strings can name embedded resources, e.g.
 * `order_items(product_id, quantity)`. The reporting code under test never
 * relies on the embed's contents (account-orders does, and is exercised
 * elsewhere), so an embed is parsed out and returned as an empty array rather
 * than silently dropped — dropping it would change the shape the caller sees.
 */
function parseColumns(select: string): { columns: string[]; embeds: string[] } {
  const columns: string[] = [];
  const embeds: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of select) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      const token = current.trim();
      if (token) (token.includes("(") ? embeds : columns).push(token);
      current = "";
      continue;
    }
    current += ch;
  }
  const last = current.trim();
  if (last) (last.includes("(") ? embeds : columns).push(last);
  return {
    columns: columns.map((c) => c.trim()),
    embeds: embeds.map((e) => e.slice(0, e.indexOf("(")).trim()),
  };
}

class SelectBuilder<T> implements PromiseLike<SelectResult<T>> {
  private filters: Filter[] = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private limitValue: number | null = null;
  private offsetValue = 0;
  private singleMode: "none" | "maybe" = "none";

  constructor(
    private readonly client: Pool,
    private readonly table: string,
    private readonly select: string,
    private readonly options: AdapterOptions,
    private readonly countMode: "exact" | null,
    private readonly headOnly: boolean,
  ) {}

  eq(column: string, value: unknown) { this.filters.push({ op: "=", column, value }); return this; }
  neq(column: string, value: unknown) { this.filters.push({ op: "<>", column, value }); return this; }
  gt(column: string, value: unknown) { this.filters.push({ op: ">", column, value }); return this; }
  gte(column: string, value: unknown) { this.filters.push({ op: ">=", column, value }); return this; }
  lt(column: string, value: unknown) { this.filters.push({ op: "<", column, value }); return this; }
  lte(column: string, value: unknown) { this.filters.push({ op: "<=", column, value }); return this; }
  is(column: string, value: unknown) { this.filters.push({ op: "is", column, value }); return this; }
  in(column: string, values: unknown[]) { this.filters.push({ op: "in", column, value: values }); return this; }

  order(column: string, opts?: { ascending?: boolean }) {
    this.orderBy = { column, ascending: opts?.ascending !== false };
    return this;
  }

  limit(value: number) { this.limitValue = value; return this; }

  range(from: number, to: number) {
    this.offsetValue = from;
    this.limitValue = to - from + 1;
    return this;
  }

  maybeSingle() { this.singleMode = "maybe"; return this as unknown as PromiseLike<{ data: T | null; error: null }>; }

  private build(): { text: string; values: unknown[] } {
    const values: unknown[] = [];
    const where: string[] = [];
    for (const f of this.filters) {
      const col = quoteIdent(f.column);
      if (f.op === "in") {
        const list = f.value as unknown[];
        if (list.length === 0) { where.push("false"); continue; }
        values.push(list);
        where.push(`${col} = any($${values.length})`);
      } else if (f.op === "is") {
        if (f.value === null) where.push(`${col} is null`);
        else { values.push(f.value); where.push(`${col} is not distinct from $${values.length}`); }
      } else {
        values.push(f.value);
        where.push(`${col} ${f.op} $${values.length}`);
      }
    }

    const { columns } = parseColumns(this.select);
    const projection = this.countMode && this.headOnly
      ? "count(*)::int8 as __count"
      : columns.includes("*")
        ? "*"
        : columns.map(quoteIdent).join(", ");

    let text = `select ${projection} from public.${quoteIdent(this.table)}`;
    if (where.length) text += ` where ${where.join(" and ")}`;
    if (!(this.countMode && this.headOnly)) {
      if (this.orderBy) text += ` order by ${quoteIdent(this.orderBy.column)} ${this.orderBy.ascending ? "asc" : "desc"}`;
      // db-max-rows is a server ceiling: it caps whatever the caller asked for,
      // and never raises it.
      const cap = this.options.maxRows;
      const effective = cap == null
        ? this.limitValue
        : Math.min(cap, this.limitValue ?? Number.MAX_SAFE_INTEGER);
      if (effective != null && Number.isFinite(effective)) text += ` limit ${Math.max(0, Math.floor(effective))}`;
      if (this.offsetValue > 0) text += ` offset ${Math.floor(this.offsetValue)}`;
    }
    return { text, values };
  }

  async then<TResult1 = SelectResult<T>, TResult2 = never>(
    onfulfilled?: ((value: never) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    try {
      const { text, values } = this.build();
      this.options.log?.push(text);
      const result = await this.client.query(text, values);
      const { embeds } = parseColumns(this.select);

      if (this.countMode && this.headOnly) {
        const payload = { data: null, error: null, count: Number(result.rows[0]?.__count ?? 0) };
        return onfulfilled ? onfulfilled(payload as never) : (payload as unknown as TResult1);
      }

      const rows = result.rows.map((row) => {
        const out = { ...row } as Record<string, unknown>;
        for (const embed of embeds) out[embed] = [];
        return out;
      }) as T[];

      if (this.singleMode === "maybe") {
        const payload = { data: rows[0] ?? null, error: null };
        return onfulfilled ? onfulfilled(payload as never) : (payload as unknown as TResult1);
      }

      const payload = { data: rows, error: null, count: this.countMode ? rows.length : null };
      return onfulfilled ? onfulfilled(payload as never) : (payload as unknown as TResult1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Mirror PostgREST: a missing column is reported as an error object on the
      // response, never thrown — the reporting code branches on exactly that.
      const payload = {
        data: null,
        error: { message, code: /column .* does not exist/i.test(message) ? "42703" : undefined },
        count: null,
      };
      if (onrejected && !(error instanceof Error)) return onrejected(error);
      return onfulfilled ? onfulfilled(payload as never) : (payload as unknown as TResult1);
    }
  }
}

export interface PgSupabaseClient {
  from<T = Record<string, unknown>>(table: string): {
    select(select: string, opts?: { count?: "exact"; head?: boolean }): SelectBuilder<T>;
  };
  rpc(name: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

export function createPgSupabaseClient(client: Pool, options: AdapterOptions = {}): PgSupabaseClient {
  return {
    from<T>(table: string) {
      return {
        select(select: string, opts?: { count?: "exact"; head?: boolean }) {
          return new SelectBuilder<T>(client, table, select, options, opts?.count ?? null, opts?.head === true);
        },
      };
    },
    async rpc(name: string, args?: Record<string, unknown>) {
      const entries = Object.entries(args ?? {});
      const params = entries.map((_, i) => `$${i + 1}`);
      const named = entries.map(([key], i) => `${quoteIdent(key)} => $${i + 1}`);
      const text = `select * from public.${quoteIdent(name)}(${named.join(", ")})`;
      options.log?.push(text);
      try {
        const result = await client.query(text, entries.map(([, v]) => v));
        void params;
        return { data: result.rows, error: null };
      } catch (error) {
        return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
      }
    },
  };
}
