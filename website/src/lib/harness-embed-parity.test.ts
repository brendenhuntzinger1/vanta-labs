import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// THE HARNESS MUST BE ABLE TO ANSWER THE QUERIES THE APP ACTUALLY SENDS.
//
// scripts/pgrst-shim.mjs used to drop every embedded select — `select=*,
// order_items(*)` came back as an order with no items, and the row simply
// lacked the key. Its own docblock claimed the opposite ("returned as
// correlated json subqueries"), and the runbook told readers embeds were "not
// implemented", so the gap was documented in two contradictory ways and fixed
// in neither.
//
// It cost three audit phases: the order-detail page could not be
// browser-tested (it 400ed), a membership store-credit grant fell back to unit
// tests, and a nested order_items read of a column that does not exist stayed
// invisible — the harness could not have caught it.
//
// Underneath was a schema gap, not a parser gap. Embeds resolve their join
// from pg_constraint the way PostgREST does, and the bootstrap's `create table
// if not exists` silently discards `references` clauses on a table that already
// exists. Production carried 35 foreign keys; the harness carried 17, missing
// all three of the relationships the application embeds most.
//
// These are source assertions rather than live queries because the suite must
// pass with no harness running. The live proof is in the runbook and was
// re-run when this landed.
// ---------------------------------------------------------------------------

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("the shim resolves embedded selects", () => {
  const shim = source("scripts/pgrst-shim.mjs");

  it("no longer drops every part containing a parenthesis", () => {
    // Comment lines are stripped first. The docblock explaining what was
    // removed quotes the old line verbatim, and matching that put this test red
    // against a file that no longer contains the code — the same way an earlier
    // assertion in this sweep matched Phase 7's prose about `.catch(() => 0)`.
    const executable = shim
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(executable).not.toContain("embeds unsupported");
    expect(executable).not.toMatch(/if \(p\.includes\("\("\)\) return null/);
  });

  it("reads the join out of the catalogue instead of guessing it", () => {
    expect(shim).toContain("pg_constraint");
    expect(shim).toContain("function relationBetween");
    // Both directions: a child array and a parent object.
    expect(shim).toContain('kind: "many"');
    expect(shim).toContain('kind: "one"');
  });

  it("refuses to invent a join when no foreign key exists, and says so", () => {
    expect(shim).toContain("no foreign key joins");
    // Loudly. A silent drop is what made this invisible for so long.
    expect(shim).toMatch(/console\.warn\([^)]*no foreign key joins/);
  });

  it("keeps a bare star bare", () => {
    // ident("*") produces a column literally named "*", which is a 42703. This
    // was the first thing the rewrite got wrong, on `select=*,order_items(*)`.
    expect(shim).toContain('if (p === "*") { out.push("*"); continue; }');
  });

  it("parses the shapes the application actually sends", () => {
    // Asserting the parser's own regex source is unreadable and proves nothing.
    // Lift the pattern out of the shim and run it against the four real select
    // fragments this codebase sends, which is what has to keep working.
    const match = shim.match(/const embed = p\.match\((\/.+\/[a-z]*)\);/);
    expect(match, "embed pattern not found in the shim").toBeTruthy();

    const pattern: RegExp = new Function(`return ${match![1]}`)() as RegExp;

    const cases: Array<[string, string, string]> = [
      ["order_items(product_id,quantity)", "order_items", "product_id,quantity"],
      ["items:order_items(product_id,quantity)", "order_items", "product_id,quantity"],
      ["membership_tiers(name,slug)", "membership_tiers", "name,slug"],
      ["order_items(*)", "order_items", "*"],
    ];

    for (const [input, table, inner] of cases) {
      const m = input.match(pattern);
      expect(m, `did not parse: ${input}`).toBeTruthy();
      expect(m![2]).toBe(table);
      expect(m![3]).toBe(inner);
    }

    // And a plain column must NOT look like an embed.
    expect("order_id".match(pattern)).toBeNull();
  });
});

describe("the harness carries the foreign keys the embeds resolve through", () => {
  const parity = source("src/lib/sql/harness-prod-parity-foreign-keys.sql");
  const bootstrap = source("scripts/setup-local-harness.sh");

  it("declares the three relationships the application embeds", () => {
    expect(parity).toContain("('order_items',               'order_id',          'orders',                   'order_id')");
    expect(parity).toContain("('customer_memberships',      'tier_id',           'membership_tiers',         'id')");
    expect(parity).toContain("('product_doses',             'product_id',        'products',                 'id')");
  });

  it("is applied by the bootstrap, or it protects nothing", () => {
    expect(bootstrap).toContain("harness-prod-parity-foreign-keys.sql");
  });

  it("runs AFTER the parity columns, since a key validates existing rows", () => {
    const columns = bootstrap.indexOf("harness-prod-parity-columns.sql");
    const keys = bootstrap.indexOf("harness-prod-parity-foreign-keys.sql");
    expect(columns).toBeGreaterThan(-1);
    expect(keys).toBeGreaterThan(columns);
  });

  it("skips a key it cannot add rather than aborting the bootstrap", () => {
    // The harness has no `users` table (no GoTrue), so three of these keys can
    // never land there. A bootstrap that died on the first one would leave a
    // half-built database, which is harder to reason about than a missing key.
    expect(parity).toContain("column or table absent");
    expect(parity).toContain("exception when others then");
  });

  it("does not invent an ON DELETE action production does not have", () => {
    expect(parity).not.toMatch(/on delete cascade/i);
    expect(parity).not.toMatch(/on delete set null/i);
  });
});

describe("the runbook no longer tells people embeds are unavailable", () => {
  const runbook = source("docs/BROWSER-TESTING-RUNBOOK.md");

  it("says they work, and what to do when one comes back empty", () => {
    expect(runbook).not.toContain("are not implemented. If a query");
    expect(runbook).toContain("no foreign key joins X to Y; dropping embed");
  });
});
