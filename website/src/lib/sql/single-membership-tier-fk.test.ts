import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// ONE FOREIGN KEY FROM customer_memberships TO membership_tiers. EXACTLY ONE.
//
// PostgREST resolves the embed `membership_tiers(*)` by looking for THE
// relationship between the two tables. A second FK — however sensible it looks
// in isolation — makes that lookup ambiguous and PostgREST refuses the query
// outright (PGRST201). Every membership read in this app uses that embed, so a
// second FK does not degrade anything: it takes membership billing, store
// credit and the account page down at once.
//
// This is not hypothetical. On 2026-09-05 a migration added
// customer_memberships.pending_tier_id ... references membership_tiers(id)
// and the very next sweep tick failed membership_billing and store_credit in
// production until the constraint was dropped twelve minutes later. Any
// future column that points at a tier (pending_tier_id, previous_tier_id,
// gifted_from_tier_id, ...) must be a plain uuid the code validates itself.
// ---------------------------------------------------------------------------

const SQL_ROOT = path.resolve(__dirname);

function sqlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sqlFiles(full));
    else if (entry.endsWith(".sql")) out.push(full);
  }
  return out;
}

/** Strip `-- ...` comments so prose about the incident does not trip the check. */
function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

const TARGETS_MEMBERSHIPS = /\b(alter|create)\s+table\s+(if\s+(not\s+)?exists\s+)?(public\.)?customer_memberships\b/i;
const REFERENCES_TIERS = /\breferences\s+(public\.)?membership_tiers\b/gi;

describe("customer_memberships has exactly one foreign key to membership_tiers", () => {
  const files = sqlFiles(SQL_ROOT);

  it("scans the SQL sources at all", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    it(`${path.relative(SQL_ROOT, file)} never adds a second one`, () => {
      const statements = withoutComments(readFileSync(file, "utf8")).split(";");
      for (const statement of statements) {
        if (!TARGETS_MEMBERSHIPS.test(statement)) continue;
        const refs = statement.match(REFERENCES_TIERS) ?? [];
        if (/\balter\s+table\b/i.test(statement)) {
          // An ALTER can only ever be adding a SECOND one: tier_id's FK is born
          // with the table.
          expect(refs, `${path.basename(file)}: ALTER TABLE customer_memberships adds a FK to membership_tiers — see the header of this test`).toHaveLength(0);
        } else {
          expect(refs.length, `${path.basename(file)}: CREATE TABLE customer_memberships declares more than one FK to membership_tiers`).toBeLessThanOrEqual(1);
          // If the CREATE names it, it must be tier_id — the one PostgREST knows.
          if (refs.length === 1) {
            expect(statement).toMatch(/\btier_id\s+uuid[^,]*references\s+(public\.)?membership_tiers/i);
          }
        }
      }
    });
  }
});
