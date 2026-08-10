import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_FUNCTIONS } from "./inventory-reservation-check";

/**
 * The reservation check must be trustworthy in both directions.
 *
 * It exists because the reservation layer fails OPEN: a missing migration looks
 * identical to a working one until two customers buy the same last unit. So the
 * check has to be right about absence AND about its own inability to tell,
 * and it must not create the very side effects it is inspecting.
 */

const source = readFileSync(join(process.cwd(), "src/lib/inventory-reservation-check.ts"), "utf8");
const migration = readFileSync(join(process.cwd(), "src/lib/sql/inventory-reservations.sql"), "utf8");

describe("it looks for everything the migration creates", () => {
  it("requires all four reservation functions", () => {
    expect([...REQUIRED_FUNCTIONS]).toEqual([
      "reserve_inventory",
      "finalize_inventory_for_order",
      "release_inventory_for_order",
      "expire_stale_reservations",
    ]);
  });

  it("every function it requires is actually defined by the migration", () => {
    // Guards against drift in either direction: a check for a function that
    // does not exist would report a permanent false failure.
    for (const fn of REQUIRED_FUNCTIONS) {
      expect(migration, `${fn} is not created by the migration`).toMatch(
        new RegExp(`create or replace function public\\.${fn}\\b`),
      );
    }
  });

  it("every function the migration defines is checked", () => {
    const defined = [...migration.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);
    expect([...defined].sort()).toEqual([...REQUIRED_FUNCTIONS].sort());
  });

  it("checks the columns and the table the migration adds", () => {
    expect(source).toContain('columnExists("products", "reserved_quantity")');
    expect(source).toContain('columnExists("product_doses", "reserved_quantity")');
    expect(source).toContain('tableExists("inventory_reservations")');
    expect(migration).toContain("public.products      add column if not exists reserved_quantity");
    expect(migration).toContain("public.product_doses add column if not exists reserved_quantity");
    expect(migration).toContain("create table if not exists public.inventory_reservations");
  });
});

describe("it never causes the effects it is inspecting", () => {
  it("does not call any reservation function", () => {
    // Calling reserve_inventory to prove it exists would hold real stock;
    // finalize_inventory_for_order would permanently decrement it.
    expect(source).not.toMatch(/\.rpc\(/);
    for (const fn of REQUIRED_FUNCTIONS) {
      expect(source).not.toContain(`rpc("${fn}"`);
    }
  });

  it("detects functions from the published schema instead", () => {
    expect(source).toContain('path.startsWith("/rpc/")');
  });

  it("reads at most one row when probing a column or table", () => {
    expect(source.match(/\.limit\(1\)/g) ?? []).toHaveLength(2);
  });

  it("performs no writes at all", () => {
    for (const write of [".insert(", ".update(", ".upsert(", ".delete("]) {
      expect(source).not.toContain(write);
    }
  });
});

describe("it distinguishes absent from unknown", () => {
  it("reports inconclusive when the schema cannot be read", () => {
    // A failed request is not evidence of a missing migration, and reporting it
    // as one would send someone to re-run a migration that is already there.
    expect(source).toContain("const inconclusive = rpcs === null;");
    expect(source).toContain("Cannot determine");
  });

  it("never claims applied while inconclusive", () => {
    expect(source).toContain("const applied = !inconclusive && checks.every((check) => check.present);");
  });

  it("says what a missing migration actually costs, not just that it is missing", () => {
    expect(source).toMatch(/two customers can buy the same last unit/i);
  });
});

describe("the migration is safe to run twice", () => {
  it("is idempotent, so a re-run cannot damage a database that already has it", () => {
    // The admin panel tells the owner to run it; that instruction is only safe
    // if this holds.
    const creates = [...migration.matchAll(/create (table|unique index|index)([^\n]*)/g)].map((m) => m[0]);
    expect(creates.length).toBeGreaterThan(0);
    for (const statement of creates) {
      expect(statement, statement).toContain("if not exists");
    }
    expect(migration).not.toMatch(/drop\s+(table|function|index)/i);
  });
});
