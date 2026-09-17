import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The consent snapshot is the migration's evidence: what the STORE said
 * about every address at one instant, taken before the first write to
 * Omnisend, so a later snapshot under another label can prove that nobody
 * was re-subscribed on the strength of anything Omnisend holds. It cannot
 * be exercised against a database here, so what makes it trustworthy is
 * pinned in source:
 *
 *   * server-only; the gate is asked before any database work;
 *   * it walks the SAME population the push walks, through the loaders the
 *     push exports, plus the suppression list — the people a resubscribe
 *     would harm — and collects each address through collectContactFacts,
 *     the one function that derives consent, so the snapshot and the push
 *     cannot disagree about a person;
 *   * one snapshot per label: a label that already has rows is skipped,
 *     never appended to;
 *   * rows go in chunks of 500 with exactly the migration's columns;
 *   * the snapshot's label and instant are recorded on the migration row;
 *   * no log line names an address.
 */
const SOURCE = readFileSync(join(process.cwd(), "src/lib/marketing/omnisend/migration-snapshot.ts"), "utf8");
const SQL = readFileSync(join(process.cwd(), "src/lib/sql/omnisend-sync.sql"), "utf8");
const PARITY = readFileSync(join(process.cwd(), "src/lib/supabase-schema-parity.test.ts"), "utf8");

function executable(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

const snapshot = executable(SOURCE);

function fn(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}\n");
  return rest.slice(0, end > 0 ? end : undefined);
}

describe("migration-snapshot.ts is server-only and gated", () => {
  it("imports server-only on its first line", () => {
    expect(SOURCE.split("\n")[0]).toBe('import "server-only";');
  });

  it("asks the gate before any database work", () => {
    const entry = fn(snapshot, "snapshotOmnisendConsent");
    const gate = entry.indexOf("omnisendActive()");
    expect(gate).toBeGreaterThan(-1);
    expect(entry.slice(0, gate)).not.toContain("await ");
    expect(entry.slice(0, gate)).not.toContain("supabaseAdmin");
  });

  it("never throws: the entry point catches, logs under the module prefix and returns a result", () => {
    expect(snapshot).toContain('const LOG = "[omnisend/snapshot]";');
    const entry = fn(snapshot, "snapshotOmnisendConsent");
    expect(entry).toMatch(/\} catch \(error\) \{\s*console\.error\(LOG, "snapshot threw", error\);\s*return \{/);
  });
});

describe("the snapshot walks the push's population through the push's loaders", () => {
  it("imports the loaders from reconcile.ts rather than duplicating them", () => {
    expect(snapshot).toMatch(/import \{[^}]*loadAudience[^}]*\} from "@\/lib\/marketing\/omnisend\/reconcile";/);
    expect(snapshot).toMatch(/import \{[^}]*loadPaidBuyers[^}]*\} from "@\/lib\/marketing\/omnisend\/reconcile";/);
    expect(snapshot).toMatch(/import \{[^}]*loadSuppressionReasons[^}]*\} from "@\/lib\/marketing\/omnisend\/reconcile";/);
    expect(snapshot).toMatch(/import \{[^}]*orderPushTargets[^}]*\} from "@\/lib\/marketing\/omnisend\/reconcile-plan";/);
    expect(snapshot).toMatch(/import \{[^}]*collectContactFacts[^}]*\} from "@\/lib\/marketing\/omnisend\/contacts";/);
    expect(snapshot).not.toContain('from("marketing_subscribers")');
    expect(snapshot).not.toContain('from("customer_preferences")');
    expect(snapshot).not.toContain('from("orders")');
  });

  it("refuses to snapshot a population it could not read in full", () => {
    const entry = fn(snapshot, "snapshotOmnisendConsent");
    expect(entry).toContain("if (!audience || !suppressions || !withdrawn)");
  });

  it("adds the suppressed and the withdrawn addresses to the push targets, so a resubscribe would show", () => {
    // A guest who unsubscribed on the site with no order and no suppression
    // row, and an account with the marketing box unticked, are in neither
    // the audience nor the suppression list; they are exactly the people a
    // re-subscribe would harm, so they are in the snapshot.
    expect(snapshot).toMatch(/import \{[^}]*loadWithdrawnConsent[^}]*\} from "@\/lib\/marketing\/omnisend\/reconcile";/);
    const entry = fn(snapshot, "snapshotOmnisendConsent");
    expect(entry).toContain("orderPushTargets(audience, buyers)");
    expect(entry).toContain("[...suppressions.keys()].sort()");
    expect(entry).toContain("[...withdrawn].sort()");
  });

  it("collects every address through collectContactFacts", () => {
    expect(snapshot).toContain("collectContactFacts(email)");
  });
});

describe("one snapshot per label, in chunks of 500", () => {
  it("counts the label's rows before inserting and skips when any exist", () => {
    const entry = fn(snapshot, "snapshotOmnisendConsent");
    const count = entry.indexOf("await countLabelRows(label)");
    const insert = entry.indexOf("await insertRows(");
    expect(count).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(count);
    expect(entry.slice(count, insert)).toMatch(/if \(existing === null\)[\s\S]*?return \{[^}]*skipped/);
    expect(entry.slice(count, insert)).toMatch(/if \(existing > 0\)[\s\S]*?return \{[^}]*skipped/);
    const counter = fn(snapshot, "countLabelRows");
    expect(counter).toMatch(/from\("omnisend_consent_snapshot"\)\s*\.select\("id", \{ count: "exact", head: true \}\)\s*\.eq\("label", label\)/);
  });

  it("inserts the migration's columns and nothing else, 500 rows at a time", () => {
    expect(snapshot).toContain("const SNAPSHOT_CHUNK = 500;");
    const insert = fn(snapshot, "insertRows");
    expect(insert).toContain("chunk(rows, SNAPSHOT_CHUNK)");
    expect(insert).toMatch(/from\("omnisend_consent_snapshot"\)\s*\.insert\(batch\)/);
    const row = snapshot.slice(snapshot.indexOf("function snapshotRow("), snapshot.indexOf("\n}\n", snapshot.indexOf("function snapshotRow(")));
    for (const column of [
      "taken_at",
      "label",
      "email",
      "email_status",
      "sms_status",
      "phone_present",
      "sources",
      "suppressed_reason",
      "orders",
      "last_order_at",
    ]) {
      expect(row, column).toMatch(new RegExp(`\\b${column}:`));
    }
  });

  it("records the label and instant on the migration row after the rows are in", () => {
    const entry = fn(snapshot, "snapshotOmnisendConsent");
    const insert = entry.indexOf("await insertRows(");
    const record = entry.indexOf("await recordMigrationSnapshot({ label, at: takenAt })");
    expect(record).toBeGreaterThan(insert);
  });
});

describe("no log line names a person", () => {
  it("never logs an email, phone, token or code", () => {
    const logs = snapshot.match(/console\.\w+\([^\n]*/g) ?? [];
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toMatch(/\b(email|phone|token|code)\b/);
    }
  });
});

describe("the migration SQL and the schema-parity allowance", () => {
  it("creates omnisend_consent_snapshot with the documented columns, index and RLS", () => {
    const table = SQL.slice(SQL.indexOf("create table if not exists public.omnisend_consent_snapshot"));
    expect(table).toContain("id bigserial primary key");
    expect(table).toContain("taken_at timestamptz not null");
    expect(table).toContain("label text not null");
    expect(table).toContain("email text not null");
    expect(table).toContain("email_status text not null");
    expect(table).toContain("sms_status text not null");
    expect(table).toContain("phone_present boolean not null");
    expect(table).toContain("sources jsonb not null");
    expect(table).toContain("suppressed_reason text");
    expect(table).toContain("orders integer not null");
    expect(table).toContain("last_order_at timestamptz");
    expect(table).toMatch(/create index if not exists \w+\s+on public\.omnisend_consent_snapshot \(label, email\)/);
    expect(table).toContain("alter table public.omnisend_consent_snapshot enable row level security;");
    expect(SQL).not.toMatch(/create policy/i);
  });

  it("registers the table as pending until production has the migration", () => {
    expect(PARITY).toContain('{ table: "omnisend_consent_snapshot", migration: "omnisend-sync.sql" }');
  });
});
