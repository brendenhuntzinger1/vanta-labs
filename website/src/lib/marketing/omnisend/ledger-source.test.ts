import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Omnisend event ledger is the exactly-once guarantee for order events,
 * and it copies the ad ledger's contract line for line: the CLAIM is an
 * insert (a read-then-write would let two callers both see "unsent"), a
 * duplicate key means someone else has it, and any other ledger failure FAILS
 * OPEN — losing an event to avoid a duplicate is the wrong trade for a
 * marketing platform that deduplicates historical events itself.
 */
const LEDGER = readFileSync(join(process.cwd(), "src/lib/marketing/omnisend/ledger.ts"), "utf8");
const SQL = readFileSync(join(process.cwd(), "src/lib/sql/omnisend-sync.sql"), "utf8");

function fn(name: string): string {
  // Search from the implementation, not the type declaration above it.
  const base = LEDGER.indexOf("export function omnisendLedger");
  const start = LEDGER.indexOf(`${name}:`, base);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = LEDGER.slice(start);
  const end = rest.indexOf("\n    },");
  return rest.slice(0, end > 0 ? end : undefined);
}

describe("the Omnisend ledger claims by inserting and fails open", () => {
  it("claims with an insert into omnisend_events_sent", () => {
    const claim = fn("claimSend");
    expect(claim).toMatch(/from\("omnisend_events_sent"\)\s*\.insert\(/);
    expect(claim).toMatch(/=== "23505"\) return false/);
    expect(claim).toMatch(/catch \{\s*return true;/);
  });

  it("records on the composite key, so one event name cannot block another", () => {
    const record = fn("recordSend");
    expect(record).toContain('onConflict: "entity_id,event_name"');
  });

  it("releases only an undelivered claim", () => {
    const release = fn("releaseSend");
    expect(release).toContain('.eq("delivered", false)');
  });

  it("the table is service-role only, keyed on (entity_id, event_name)", () => {
    expect(SQL).toMatch(/create table if not exists public\.omnisend_events_sent/);
    expect(SQL).toMatch(/primary key \(entity_id, event_name\)/);
    expect(SQL).toMatch(/alter table public\.omnisend_events_sent enable row level security/);
    expect(SQL).not.toMatch(/create policy[^;]*omnisend_events_sent/i);
    expect(SQL).toMatch(/create table if not exists public\.omnisend_sync_state/);
  });
});
