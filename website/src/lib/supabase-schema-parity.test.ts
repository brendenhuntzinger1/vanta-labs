import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import PRODUCTION_SCHEMA from "@/lib/production-schema.json";

// ---------------------------------------------------------------------------
// CODE-VS-PRODUCTION SCHEMA PARITY.
//
// A Supabase select naming a column that does not exist does NOT throw. It
// comes back as PostgREST error 42703 with `data: null`, and every call site
// that destructures `const { data } = await ...` without reading `error` turns
// that into an empty result set — a wrong ANSWER wearing a success's clothes.
//
// This is not hypothetical. Two live instances were found on 2026-08-27:
//
//   admin-profit.commissionByOrderId  selected commissions.payment_status
//     (production has `status`) -> the map was ALWAYS empty -> the profit
//     dashboard subtracted $0 of affiliate commission from every order.
//
//   /api/admin/orders/[orderId]/packing-slip  selected orders.carrier
//     (production has `shipping_carrier`) -> every packing slip 500'd.
//
// Unit tests could not catch either: the financial-surfaces fixture DDL
// invented a `commissions.payment_status` column, so the suite proved the
// reader worked against a schema production does not have.
//
// So the check lives here instead, against a snapshot of the REAL schema.
//
// WHAT THIS SCANNER USED TO MISS (and why each hole mattered).
//
// The first version read `.select(...)`, a fixed list of filters, and
// `onConflict`. Everything else was invisible, which left three blind spots
// wide enough for the original class of defect to walk straight back through:
//
//   1. WRITES. `.insert({...})`, `.update({...})` and `.upsert({...})` payload
//      keys were never checked at all — and a write is the half that actually
//      corrupts data, not merely a read that returns nothing.
//
//   2. FILTERS OUTSIDE THE FIXED LIST. `.not()`, `.match({})`, `.contains()`,
//      `.overlaps()` and the column names embedded in `.or("col.eq.x,...")`
//      strings all named columns the scanner never looked at. `.or()` is the
//      worst of them: the columns are buried in a PostgREST mini-language
//      inside a string literal, so nothing else in the toolchain sees them
//      either.
//
//   3. EMBEDDED RESOURCES. `items:order_items(a, b)` was stripped and thrown
//      away to avoid attributing `a` and `b` to the PARENT table. Correct as
//      far as it went, but it meant the embedded table's own columns were
//      checked against nothing. They are now checked against `order_items`.
//
// REGENERATING THE SNAPSHOT (read-only, safe to run against production):
//
//   select table_name, string_agg(column_name, ',' order by ordinal_position)
//   from information_schema.columns
//   where table_schema='public' group by table_name order by table_name;
//
// then reshape into src/lib/production-schema.json ({ table: [columns] }).
// Regenerate it whenever a migration lands, in the SAME commit as the code that
// depends on the new column.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), "src");

const schema = PRODUCTION_SCHEMA as Record<string, string[]>;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // e2e/ builds its own fixture databases on purpose — those DDLs are
      // allowed to differ from production and are not call sites.
      if (entry !== "node_modules" && entry !== "e2e") sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * The TOP-LEVEL keys of an object-literal body.
 *
 * Depth matters: `{ metadata: { foo: 1 } }` writes one column (`metadata`), not
 * two. `foo` is a key inside a jsonb VALUE, and reporting it as a missing
 * column would be a false positive on every jsonb write in the codebase.
 *
 * Spreads and computed keys are skipped rather than guessed at — this is a
 * static scanner, and a wrong "missing column" is worse than a missed one.
 */
export function topLevelKeys(payload: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let tokenStart = 0;
  const segments: string[] = [];

  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload[i];
    if (quote) {
      if (ch === quote && payload[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      segments.push(payload.slice(tokenStart, i));
      tokenStart = i + 1;
    }
  }
  segments.push(payload.slice(tokenStart));

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed || trimmed.startsWith("...")) continue;
    // `key:` / `"key":` / shorthand `key`. A computed `[expr]:` is not a
    // literal column name and is skipped.
    const named = /^["'`]?([a-z_][a-z_0-9]*)["'`]?\s*:/.exec(trimmed);
    if (named) {
      keys.push(named[1]);
      continue;
    }
    if (/^[a-z_][a-z_0-9]*$/.test(trimmed)) keys.push(trimmed);
  }
  return keys;
}

export interface ColumnReference {
  file: string;
  line: number;
  table: string;
  columns: string[];
}

/**
 * Collect the columns each `.from("table")` chain names.
 *
 * The window deliberately stops at the FIRST of: the statement's closing
 * bracket, a top-level `;`, or the next `.from(`. That last one matters —
 * `Promise.all([ from(a).select(x), from(b).select(y) ])` would otherwise
 * attribute b's columns to a and report a wall of false positives.
 */
export function collectColumnReferences(files: string[]): ColumnReference[] {
  const refs: ColumnReference[] = [];
  for (const file of files) {
    refs.push(...scanSource(readFileSync(file, "utf8"), file.slice(process.cwd().length + 1)));
  }
  return refs;
}

/**
 * Scan ONE source string. Split out from the file walk so the negative controls
 * below can hand it a snippet: a scanner whose behaviour can only be observed
 * by running it over the whole repository cannot be tested for the things it
 * fails to see.
 */
export function scanSource(src: string, fileLabel = "<inline>"): ColumnReference[] {
  const refs: ColumnReference[] = [];
  {
    const file = fileLabel;
    const from = /\.from\(\s*["'`]([a-z_0-9]+)["'`]\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = from.exec(src))) {
      const start = match.index + match[0].length;
      let depth = 0;
      let end = src.length;
      for (let i = start; i < src.length; i += 1) {
        const ch = src[i];
        if (ch === "(" || ch === "{" || ch === "[") depth += 1;
        else if (ch === ")" || ch === "}" || ch === "]") {
          depth -= 1;
          if (depth < 0) {
            end = i;
            break;
          }
        } else if (ch === ";" && depth === 0) {
          end = i;
          break;
        }
      }
      let window = src.slice(start, end);
      const nextFrom = window.indexOf(".from(");
      if (nextFrom >= 0) window = window.slice(0, nextFrom);

      const columns = new Set<string>();
      // Columns belonging to an EMBEDDED table rather than to `table`, keyed by
      // the embedded table's real name. Blind spot 3.
      const embedded = new Map<string, Set<string>>();

      const select = /\.select\(\s*["'`]([^"'`]*)["'`]/.exec(window);
      if (select) {
        // Embedded-resource selects (`items:order_items(a,b)`,
        // `order_items(a,b)`) name a RELATION, so their columns belong to THAT
        // table, not to this one. They used to be dropped here and checked
        // nowhere — which is precisely how VL-1 survived: the cancel path asked
        // for `order_items(product_id, variant_id, quantity)` against a table
        // that has no variant_id, PostgREST answered 42703, and EVERY
        // cancellation returned "unavailable" instead of returning stock. The
        // scanner reported no violation because it had thrown the embed away.
        // They are checked against their own table now.
        //
        // The `!hint` group matches PostgREST's disambiguating FK hint
        // (`order_items!fk_order(...)`), so a hinted embed is resolved to its
        // real table rather than skipped.
        const body = select[1];
        for (const rel of body.matchAll(
          /(?:([a-z_0-9]+)\s*:\s*)?([a-z_0-9]+)(?:!\s*[a-z_0-9]+)?\s*\(([^()]*)\)/gi,
        )) {
          // `alias:real_table(cols)` — the REAL table is group 2 either way.
          const relation = rel[2].toLowerCase();
          const bucket = embedded.get(relation) ?? new Set<string>();
          for (const raw of rel[3].split(",")) {
            const column = raw.trim().split(":").pop()!.trim();
            if (column && column !== "*" && /^[a-z_][a-z_0-9]*$/.test(column)) bucket.add(column);
          }
          if (bucket.size > 0) embedded.set(relation, bucket);
        }

        const flat = body
          .replace(/[a-z_0-9]+\s*:\s*[a-z_0-9]+\s*\([^)]*\)/gi, "")
          .replace(/[a-z_0-9]+\s*\([^)]*\)/gi, "");
        for (const raw of flat.split(",")) {
          const trimmed = raw.trim();
          if (!trimmed || trimmed === "*" || trimmed.includes("(")) continue;
          const column = trimmed.split(":").pop()!.trim();
          if (/^[a-z_][a-z_0-9]*$/.test(column)) columns.add(column);
        }
      }

      // Blind spot 2a: the filter list was short. `.not`, `.contains`,
      // `.overlaps`, `.rangeGt` and friends all take a column name first.
      for (const filter of window.matchAll(
        /\.(eq|neq|gt|gte|lt|lte|is|in|like|ilike|likeAllOf|likeAnyOf|ilikeAllOf|ilikeAnyOf|order|not|contains|containedBy|overlaps|rangeGt|rangeGte|rangeLt|rangeLte|rangeAdjacent|textSearch)\(\s*["'`]([a-z_0-9]+)["'`]/g,
      )) {
        columns.add(filter[2]);
      }

      // Blind spot 2b: `.or("a.eq.1,b.is.null")` and `.match({ a: 1 })` hide
      // their columns inside a string / object literal.
      for (const or of window.matchAll(/\.or\(\s*["'`]([^"'`]*)["'`]/g)) {
        // PostgREST logic strings: `col.op.value`, comma-separated, with
        // `and(...)`/`or(...)` groups. Take the identifier before each `.op.`.
        for (const term of or[1].matchAll(/(?:^|[,(])\s*([a-z_][a-z_0-9]*)\s*\.\s*(?:eq|neq|gt|gte|lt|lte|is|in|like|ilike|not|cs|cd|ov|fts|plfts|phfts|wfts)\b/g)) {
          columns.add(term[1]);
        }
      }
      for (const match_ of window.matchAll(/\.match\(\s*\{([^}]*)\}/g)) {
        for (const key of match_[1].matchAll(/(?:^|,)\s*["'`]?([a-z_][a-z_0-9]*)["'`]?\s*:/g)) {
          columns.add(key[1]);
        }
      }

      // Blind spot 1: WRITE payloads. A select naming a missing column returns
      // nothing; an insert/update naming one fails outright, and neither was
      // being checked. Only object-literal payloads are readable statically —
      // a spread or a variable is skipped rather than guessed at.
      for (const write of window.matchAll(/\.(insert|update|upsert)\(\s*(\{)/g)) {
        const openIndex = write.index! + write[0].length - 1;
        let depth = 0;
        let close = window.length;
        for (let i = openIndex; i < window.length; i += 1) {
          const ch = window[i];
          if (ch === "{") depth += 1;
          else if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
              close = i;
              break;
            }
          }
        }
        const payload = window.slice(openIndex + 1, close);
        // TOP-LEVEL keys only: a nested object is a jsonb VALUE, and its keys
        // are not columns. Tracking depth keeps `metadata: { foo: 1 }` from
        // reporting `foo` as a missing column of the table.
        for (const key of topLevelKeys(payload)) columns.add(key);
      }

      for (const conflict of window.matchAll(/onConflict\s*:\s*["'`]([a-z_0-9, ]+)["'`]/g)) {
        for (const column of conflict[1].split(",")) if (column.trim()) columns.add(column.trim());
      }

      const line = src.slice(0, match.index).split("\n").length;
      const shortFile = file;
      if (columns.size > 0) {
        refs.push({ file: shortFile, line, table: match[1], columns: [...columns] });
      }
      for (const [relation, cols] of embedded) {
        refs.push({ file: shortFile, line, table: relation, columns: [...cols] });
      }
    }
  }
  return refs;
}

describe("supabase reads match the production schema", () => {
  const references = collectColumnReferences(sourceFiles(SRC));

  it("finds call sites to check (guards against the scanner silently matching nothing)", () => {
    expect(references.length).toBeGreaterThan(200);
  });

  it("never selects or filters on a column production does not have", () => {
    const violations: string[] = [];
    for (const ref of references) {
      const real = schema[ref.table];
      // A table absent from the snapshot is reported by the next test rather
      // than failing here: a migration may legitimately land before the
      // snapshot is refreshed, and blocking that would be worse than noting it.
      if (!real) continue;
      const known = new Set(real);
      const missing = ref.columns.filter((column) => !known.has(column));
      if (missing.length > 0) {
        violations.push(`${ref.file}:${ref.line}  ${ref.table}.{${missing.join(", ")}}`);
      }
    }
    expect(violations, `\n${violations.join("\n")}\n`).toEqual([]);
  });

  /**
   * NEGATIVE CONTROLS FOR THE THREE BLIND SPOTS.
   *
   * Each of these asserts the scanner SEES a column it previously could not.
   * Without them, closing a blind spot and closing nothing look identical from
   * the outside — which is how the first version passed for months while a
   * broken embedded select shipped.
   */
  it("sees write-payload keys (insert/update/upsert), not just reads", () => {
    const seen = (source: string) => scanSource(source).flatMap((ref) => ref.columns);

    expect(seen(`supabaseAdmin.from("orders").update({ shipping_carrier: c, made_up_column: 1 }).eq("order_id", id);`))
      .toEqual(expect.arrayContaining(["shipping_carrier", "made_up_column", "order_id"]));
    expect(seen(`supabaseAdmin.from("orders").insert({ order_id: id, amount_paid: 1 });`))
      .toEqual(expect.arrayContaining(["order_id", "amount_paid"]));
    expect(seen(`supabaseAdmin.from("orders").upsert({ order_id: id }, { onConflict: "order_id" });`))
      .toEqual(expect.arrayContaining(["order_id"]));

    // A nested object is a jsonb VALUE. Its keys are not columns, and reporting
    // them would be a false positive on every jsonb write in the codebase.
    expect(seen(`supabaseAdmin.from("orders").update({ context: { inner_key: 1 } });`)).toContain("context");
    expect(seen(`supabaseAdmin.from("orders").update({ context: { inner_key: 1 } });`)).not.toContain("inner_key");

    // A spread cannot be read statically, so it is skipped rather than guessed.
    expect(seen(`supabaseAdmin.from("orders").update({ ...payload });`)).toEqual([]);
  });

  it("sees columns named by .not/.or/.match/.contains, not just the original filter list", () => {
    const seen = (source: string) => scanSource(source).flatMap((ref) => ref.columns);

    expect(seen(`supabaseAdmin.from("orders").select("id").not("paid_at", "is", null);`)).toContain("paid_at");
    expect(seen(`supabaseAdmin.from("orders").select("id").or("refund_amount.gt.0,payment_status.eq.paid");`))
      .toEqual(expect.arrayContaining(["refund_amount", "payment_status"]));
    expect(seen(`supabaseAdmin.from("orders").select("id").match({ order_id: id, payment_status: "paid" });`))
      .toEqual(expect.arrayContaining(["order_id", "payment_status"]));
    expect(seen(`supabaseAdmin.from("orders").select("id").contains("shipping_address", {});`)).toContain("shipping_address");
  });

  it("checks embedded-resource columns against the EMBEDDED table, not the parent", () => {
    const refs = scanSource(
      `supabaseAdmin.from("orders").select("order_id, items:order_items(product_id, quantity)");`,
    );
    const parent = refs.find((ref) => ref.table === "orders");
    const child = refs.find((ref) => ref.table === "order_items");

    // The parent must NOT be blamed for the child's columns...
    expect(parent?.columns).toEqual(["order_id"]);
    // ...and the child's columns must be checked against the child.
    expect(child?.columns).toEqual(expect.arrayContaining(["product_id", "quantity"]));

    // The live regression this closed: order_items has no `variant_id`, so the
    // embedded select failed with 42703 and every cancellation restocked
    // nothing. Discarding embedded columns made that invisible.
    const missed = scanSource(`supabaseAdmin.from("orders").select("order_items(variant_id)");`);
    expect(missed.find((ref) => ref.table === "order_items")?.columns).toContain("variant_id");
  });

  it("only touches tables the snapshot knows about", () => {
    const unknown = [
      ...new Set(references.filter((ref) => !schema[ref.table]).map((ref) => ref.table)),
    ];
    expect(
      unknown,
      `Tables referenced by code but absent from production-schema.json: ${unknown.join(", ")}. ` +
        "Either the migration has not been applied to production, or the snapshot needs regenerating.",
    ).toEqual([]);
  });
});
