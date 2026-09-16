import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * omnisend_sync_state carries two rows for the migration: "migration"
 * (the cutoff instant and the last consent snapshot) and "batches" (the last
 * fifty batch submissions with what Omnisend last said about each). Neither
 * can be exercised against a database here, so what makes them safe is
 * pinned in source:
 *
 *   * server-only, so the service key stays out of every client bundle;
 *   * the cutoff is written ONCE — a later run never moves it, because the
 *     cutoff is the instant the first write to Omnisend began and the daily
 *     reconcile's delta is measured from it;
 *   * a snapshot record never overwrites the cutoff, and vice versa;
 *   * the batch list is read through the pure parser and written bounded;
 *   * every accessor catches, logs under one prefix and returns a value.
 */
const SOURCE = readFileSync(join(process.cwd(), "src/lib/marketing/omnisend/migration-state.ts"), "utf8");

function executable(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

const state = executable(SOURCE);

function fn(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}\n");
  return rest.slice(0, end > 0 ? end : undefined);
}

describe("migration-state.ts is server-only and keyed as documented", () => {
  it("imports server-only on its first line", () => {
    expect(SOURCE.split("\n")[0]).toBe('import "server-only";');
  });

  it("names the two rows it owns", () => {
    expect(state).toContain('export const MIGRATION_STATE_KEY = "migration";');
    expect(state).toContain('export const BATCHES_STATE_KEY = "batches";');
    expect(state).toContain('const LOG = "[omnisend/state]";');
  });

  it("reads and writes omnisend_sync_state one key at a time", () => {
    const read = fn(state, "readState");
    expect(read).toMatch(/from\("omnisend_sync_state"\)\s*\.select\("value"\)\s*\.eq\("key", stateKey\)/);
    const write = fn(state, "writeState");
    expect(write).toMatch(/from\("omnisend_sync_state"\)\s*\.upsert\(\{ key: stateKey, value, updated_at: new Date\(\)\.toISOString\(\) \}, \{ onConflict: "key" \}\)/);
  });
});

describe("the migration row", () => {
  it("exports readMigrationState with the three documented fields", () => {
    expect(state).toContain("export async function readMigrationState(");
    expect(state).toMatch(/cutoffAt: [^\n]*,\s*snapshotLabel: [^\n]*,\s*snapshotAt: /);
  });

  it("writes the cutoff only when none is recorded", () => {
    const cutoff = fn(state, "recordMigrationCutoff");
    const read = cutoff.indexOf("await readMigrationState()");
    const guard = cutoff.indexOf("if (existing.cutoffAt) return");
    const write = cutoff.indexOf("await writeState(MIGRATION_STATE_KEY");
    expect(read).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(read);
    expect(write).toBeGreaterThan(guard);
    expect(cutoff).toContain("...existing, cutoffAt");
  });

  it("records a snapshot without touching the cutoff", () => {
    const snapshot = fn(state, "recordMigrationSnapshot");
    expect(snapshot).toContain("await readMigrationState()");
    expect(snapshot).toContain("...existing, snapshotLabel: input.label, snapshotAt: input.at");
    expect(snapshot).not.toContain("cutoffAt:");
  });
});

describe("the batches row", () => {
  it("reads through the pure parser, telling an unreadable row from an empty one, and writes the bounded list", () => {
    // Null, not []: the reconcile merges its write onto a fresh read of this
    // row, and an unreadable row read as "no batches" would be written over,
    // dropping every unfinished id the next run was going to poll.
    const read = fn(state, "readBatchRecords");
    expect(read).toContain("const value = await readState(BATCHES_STATE_KEY);");
    expect(read).toContain("return value === null ? null : parseBatchRecords(value);");
    const write = fn(state, "writeBatchRecords");
    expect(write).toContain("await writeState(BATCHES_STATE_KEY, { batches: records.slice(-MAX_BATCH_RECORDS) })");
  });
});

describe("never throws, never names a person", () => {
  it("catches in every accessor and logs under the module prefix", () => {
    for (const name of ["readState", "writeState"]) {
      const body = fn(state, name);
      expect(body).toMatch(/\} catch \(error\) \{\s*console\.error\(LOG,/);
    }
  });

  it("has no address, phone, token or code to log", () => {
    expect(state).not.toMatch(/\b(email|phone|token|code)\b/);
  });
});
