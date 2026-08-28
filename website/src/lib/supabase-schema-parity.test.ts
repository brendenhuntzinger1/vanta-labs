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
    const src = readFileSync(file, "utf8");
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
      const select = /\.select\(\s*["'`]([^"'`]*)["'`]/.exec(window);
      const line = src.slice(0, match.index).split("\n").length;
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
        for (const embed of select[1].matchAll(
          /(?:([a-z_0-9]+)\s*:\s*)?([a-z_0-9]+)(?:!\s*[a-z_0-9]+)?\s*\(([^()]*)\)/gi,
        )) {
          const embedded = embed[2];
          const embeddedColumns = embed[3]
            .split(",")
            .map((raw) => raw.trim().split(":").pop()!.trim())
            .filter((column) => /^[a-z_][a-z_0-9]*$/.test(column));
          if (embeddedColumns.length > 0) {
            refs.push({ file: file.slice(process.cwd().length + 1), line, table: embedded, columns: embeddedColumns });
          }
        }
        const flat = select[1]
          .replace(/[a-z_0-9]+\s*:\s*[a-z_0-9]+\s*\([^)]*\)/gi, "")
          .replace(/[a-z_0-9]+\s*\([^)]*\)/gi, "");
        for (const raw of flat.split(",")) {
          const trimmed = raw.trim();
          if (!trimmed || trimmed === "*" || trimmed.includes("(")) continue;
          const column = trimmed.split(":").pop()!.trim();
          if (/^[a-z_][a-z_0-9]*$/.test(column)) columns.add(column);
        }
      }
      for (const filter of window.matchAll(
        /\.(eq|neq|gt|gte|lt|lte|is|in|like|ilike|order)\(\s*["'`]([a-z_0-9]+)["'`]/g,
      )) {
        columns.add(filter[2]);
      }
      for (const conflict of window.matchAll(/onConflict\s*:\s*["'`]([a-z_0-9, ]+)["'`]/g)) {
        for (const column of conflict[1].split(",")) if (column.trim()) columns.add(column.trim());
      }

      if (columns.size === 0) continue;
      refs.push({ file: file.slice(process.cwd().length + 1), line, table: match[1], columns: [...columns] });
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
