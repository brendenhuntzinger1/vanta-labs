// A PostgREST-shaped client backed by a real Postgres connection.
//
// WHY THIS EXISTS. Every financial-reporting surface reaches the database
// through supabase-js, and the defects Block F is chasing are ROW-COUNT
// defects: `.limit(2000)`, `.limit(10000)`, `.limit(20000)`, and one select
// with no bound at all. None of them can be reproduced against the 15 orders
// in production, and none of them can be reproduced against a hand-written
// fake — a fake proves only that the fake truncates.
//
// So the modules are run unmodified against a real Postgres holding tens of
// thousands of rows. This shim translates the exact query-builder calls those
// five modules make into SQL and runs them. The caps under test live in the
// APPLICATION, not here: this shim passes `.limit(n)` through to SQL `LIMIT n`
// and imposes no ceiling of its own.
//
// `maxRows` is the ONE piece of modelling in this file. PostgREST's
// `db-max-rows` (Supabase's "Max rows" API setting) silently caps every
// response, and it cannot be observed from this environment. Tests that set it
// are labelled as models of that documented behaviour, not as evidence about
// any particular project's configuration.
//
// Test-only. Not imported by any runtime code.

import type { Client } from "pg";

type Filter =
  | { kind: "eq" | "gt" | "gte" | "lt" | "lte"; column: string; value: unknown }
  | { kind: "in"; column: string; value: unknown[] }
  | { kind: "is"; column: string; value: null | boolean }
  | { kind: "neq"; column: string; value: unknown };

export interface ShimOptions {
  /**
   * Models PostgREST's `db-max-rows`. Null (the default) = no cap, so a test
   * that does not set it is measuring the application's own limits only.
   */
  maxRows?: number | null;
  /** Function names to treat as not-migrated, so `.rpc()` returns an error. */
  missingRpcs?: Set<string>;
  /** Every statement executed, in order — for asserting round-trip counts. */
  log?: string[];
}

export interface ShimResult<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
  count: number | null;
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return `"${name}"`;
}

// PostgREST's select string is a comma-separated column list. The five modules
// under test use plain column lists only (no embedded resources), so anything
// else is rejected loudly rather than silently mistranslated.
function projection(columns: string): string {
  const trimmed = columns.trim();
  if (trimmed === "*") return "*";
  return trimmed
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => quoteIdent(c))
    .join(", ");
}

class QueryBuilder<T> implements PromiseLike<ShimResult<T>> {
  private filters: Filter[] = [];
  private orderBy: Array<{ column: string; ascending: boolean }> = [];
  private limitValue: number | null = null;
  private offsetValue = 0;
  private single: "maybe" | null = null;

  constructor(
    private readonly client: Client,
    private readonly options: ShimOptions,
    private readonly table: string,
    private readonly columns: string,
    private readonly countMode: "exact" | null,
    private readonly headOnly: boolean,
  ) {}

  eq(column: string, value: unknown) { this.filters.push({ kind: "eq", column, value }); return this; }
  neq(column: string, value: unknown) { this.filters.push({ kind: "neq", column, value }); return this; }
  gt(column: string, value: unknown) { this.filters.push({ kind: "gt", column, value }); return this; }
  gte(column: string, value: unknown) { this.filters.push({ kind: "gte", column, value }); return this; }
  lt(column: string, value: unknown) { this.filters.push({ kind: "lt", column, value }); return this; }
  lte(column: string, value: unknown) { this.filters.push({ kind: "lte", column, value }); return this; }
  in(column: string, value: unknown[]) { this.filters.push({ kind: "in", column, value }); return this; }
  is(column: string, value: null | boolean) { this.filters.push({ kind: "is", column, value }); return this; }

  // supabase-js appends each `.order()` as an additional sort key, in call
  // order — which is what makes keyset-free paging deterministic.
  order(column: string, opts?: { ascending?: boolean }) {
    this.orderBy.push({ column, ascending: opts?.ascending !== false });
    return this;
  }

  limit(value: number) { this.limitValue = value; return this; }

  // PostgREST's Range header is INCLUSIVE at both ends.
  range(from: number, to: number) {
    this.offsetValue = from;
    this.limitValue = to - from + 1;
    return this;
  }

  maybeSingle() { this.single = "maybe"; return this; }

  private buildWhere(params: unknown[]): string {
    if (this.filters.length === 0) return "";
    const clauses = this.filters.map((filter) => {
      const col = quoteIdent(filter.column);
      switch (filter.kind) {
        case "in": {
          if (filter.value.length === 0) return "false";
          const placeholders = filter.value.map((v) => { params.push(v); return `$${params.length}`; });
          return `${col} in (${placeholders.join(", ")})`;
        }
        case "is":
          return filter.value === null ? `${col} is null` : `${col} is ${filter.value ? "true" : "false"}`;
        case "neq":
          params.push(filter.value);
          return `${col} is distinct from $${params.length}`;
        default: {
          const op = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" }[filter.kind];
          params.push(filter.value);
          return `${col} ${op} $${params.length}`;
        }
      }
    });
    return ` where ${clauses.join(" and ")}`;
  }

  async run(): Promise<ShimResult<T>> {
    const params: unknown[] = [];
    const where = this.buildWhere(params);
    const table = quoteIdent(this.table);

    let count: number | null = null;
    if (this.countMode === "exact") {
      const countSql = `select count(*)::bigint as c from ${table}${where}`;
      this.options.log?.push(countSql);
      const res = await this.client.query(countSql, params);
      count = Number(res.rows[0]?.c ?? 0);
    }
    if (this.headOnly) return { data: null, error: null, count };

    // The application's own `.limit()` first; db-max-rows, when modelled, only
    // ever tightens it — exactly the order PostgREST applies them in.
    const appLimit = this.limitValue;
    const cap = this.options.maxRows ?? null;
    const effectiveLimit = cap == null ? appLimit : appLimit == null ? cap : Math.min(appLimit, cap);

    let sql = `select ${projection(this.columns)} from ${table}${where}`;
    if (this.orderBy.length > 0) {
      sql += ` order by ${this.orderBy.map((o) => `${quoteIdent(o.column)} ${o.ascending ? "asc" : "desc"}`).join(", ")}`;
    }
    if (effectiveLimit != null) sql += ` limit ${Number(effectiveLimit)}`;
    if (this.offsetValue > 0) sql += ` offset ${Number(this.offsetValue)}`;

    this.options.log?.push(sql);
    try {
      const res = await this.client.query(sql, params);
      if (this.single === "maybe") {
        return { data: (res.rows[0] ?? null) as T, error: null, count };
      }
      return { data: res.rows as unknown as T, error: null, count };
    } catch (err) {
      const e = err as { message?: string; code?: string };
      return { data: null, error: { message: String(e.message ?? err), code: e.code }, count };
    }
  }

  then<R1 = ShimResult<T>, R2 = never>(
    onfulfilled?: ((value: ShimResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }
}

export function createPostgrestShim(client: Client, options: ShimOptions = {}) {
  return {
    from(table: string) {
      return {
        select(columns = "*", opts?: { count?: "exact"; head?: boolean }) {
          return new QueryBuilder<unknown>(client, options, table, columns, opts?.count ?? null, opts?.head === true);
        },
      };
    },
    async rpc(name: string, args?: Record<string, unknown>) {
      if (options.missingRpcs?.has(name)) {
        // What PostgREST returns when the function is not in the schema cache.
        return { data: null, error: { message: `Could not find the function public.${name} in the schema cache`, code: "PGRST202" }, count: null };
      }
      const entries = Object.entries(args ?? {});
      const params = entries.map(([, v]) => v);
      const argList = entries.map(([k], i) => `${quoteIdent(k)} => $${i + 1}`).join(", ");
      const sql = `select * from ${quoteIdent(name)}(${argList})`;
      options.log?.push(sql);
      try {
        const res = await client.query(sql, params);
        return { data: res.rows, error: null, count: null };
      } catch (err) {
        const e = err as { message?: string; code?: string };
        return { data: null, error: { message: String(e.message ?? err), code: e.code }, count: null };
      }
    },
  };
}
