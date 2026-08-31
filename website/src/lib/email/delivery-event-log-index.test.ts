import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE BUG THIS FILE EXISTS TO PREVENT A REPEAT OF.
 *
 * The recorder upserts with `onConflict: "a,b,c"` — a list of COLUMNS. The
 * migration originally created a unique index on
 * `coalesce(provider_message_id, '')`, an EXPRESSION. Postgres cannot match a
 * column list to an expression index, so every insert raised "no unique or
 * exclusion constraint matching the ON CONFLICT specification".
 *
 * Nothing caught it. The write is best-effort, so the caller swallowed the
 * error; Resend received 200 and the bounce suppression worked. The only
 * symptom was an empty table — which is exactly the state this table was added
 * to distinguish from "the webhook is not configured". It took sending real
 * events through production and comparing Resend's four Success rows against
 * zero rows here.
 *
 * These assertions tie the two halves together so they cannot drift again.
 */

const SQL = readFileSync(join(process.cwd(), "src/lib/sql/email-delivery-event-log.sql"), "utf8");
const CODE = readFileSync(join(process.cwd(), "src/lib/email/delivery-events.ts"), "utf8");

function onConflictColumns(): string[] {
  const m = CODE.match(/onConflict:\s*"([^"]+)"/);
  if (!m) throw new Error("no onConflict in delivery-events.ts");
  return m[1].split(",").map((c) => c.trim());
}

describe("the unique index can actually satisfy the upsert's ON CONFLICT", () => {
  it("indexes bare columns, never an expression", () => {
    const idx = SQL.slice(SQL.indexOf("email_delivery_events_once"));
    const body = idx.slice(idx.indexOf("("), idx.indexOf(";"));
    // coalesce()/lower()/any call makes it an expression index, which
    // PostgREST's column-list ON CONFLICT cannot target.
    expect(body).not.toMatch(/coalesce\s*\(/i);
    expect(body).not.toMatch(/lower\s*\(/i);
  });

  it("covers exactly the columns the code names in onConflict", () => {
    const idx = SQL.slice(SQL.indexOf("using btree (", SQL.indexOf("email_delivery_events_once")));
    const cols = idx.slice(idx.indexOf("(") + 1, idx.indexOf(")")).split(",").map((c) => c.trim());
    expect(cols).toEqual(onConflictColumns());
  });

  it("uses NULLS NOT DISTINCT, so a null provider id still dedupes", () => {
    // Without this, Postgres treats every NULL as unique and a redelivered
    // event with no message id would insert a second row.
    expect(SQL).toMatch(/nulls not distinct/i);
  });
});

describe("a recording failure is logged, not swallowed in silence", () => {
  it("checks the upsert's error instead of discarding it", () => {
    expect(CODE).toContain("const { error } = await supabaseAdmin");
    expect(CODE).toContain("could not record a");
  });

  it("treats only real missing-table codes as expected", () => {
    // partner-portal's helper of the same name also matches any error merely
    // MENTIONING the relation — which would have reclassified this very bug as
    // "table not migrated yet" and kept it quiet.
    const helper = CODE.slice(CODE.indexOf("function isMissingRelationError"));
    expect(helper).toContain('code === "42P01"');
    expect(helper).toContain('code === "PGRST205"');
    expect(helper.slice(0, helper.indexOf("}"))).not.toContain("includes(");
  });

  it("still never throws — a broken log must not stop a bounce suppressing", () => {
    expect(CODE).toContain("recordDeliveryEvent(event, false).catch(() => {})");
  });
});
