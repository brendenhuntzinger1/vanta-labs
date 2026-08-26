import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// I-11 — THE CONTROL THAT DOES NOT DEPEND ON AN AUTHOR REMEMBERING.
//
// Supabase grants EXECUTE on every function created in `public` to `anon` and
// `authenticated`, by default. A new SECURITY DEFINER function is therefore
// reachable by anyone holding the public anon key from the moment it exists.
// That is what made `create_partner_invite` an unauthenticated, RLS-bypassing
// write into the affiliate money tables (I-07).
//
// The default cannot be fully disarmed from this project's SQL access —
// measured, not assumed: there are two grantors, `postgres` and
// `supabase_admin`, and altering a default privilege requires the role that
// granted it. Revoking as `postgres` leaves `supabase_admin`'s entry intact and
// a newly created function still anon-executable. See
// `sql/rpc-default-privilege-lockdown.sql` for the probe output.
//
// So the reliable control is that every migration creating a function revokes
// for itself. Block I's own drift-check file records why that is not enough on
// its own:
//
//   "Two authors remembered, two did not, and the one that did not created a
//    brand-new function -- so it took the defaults and was world-executable."
//
// A SQL file someone has to remember to run has the same failure mode as the
// revoke someone has to remember to write. This test is the part that runs
// whether anyone remembers or not.
// ---------------------------------------------------------------------------

const SQL_DIR = path.resolve(process.cwd(), "src/lib/sql");

/**
 * Functions the storefront is MEANT to call with the anon key. Adding to this
 * list is a deliberate act and should be argued for in review — which is the
 * point of it being a list rather than a heuristic.
 */
const CLIENT_CALLABLE = new Set(["validate_referral_code"]);

/**
 * Files that are captures or historical records rather than migrations to run.
 * A verbatim capture of production must not be edited to satisfy a linter.
 */
const NOT_A_MIGRATION = new Set([
  "BASELINE-live-functions-2026-08-25.sql",
  "rpc-exposure-drift-check.sql",
  "production-readiness-checks.sql",
]);

function sqlFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(dir, entry.name))
        : entry.name.endsWith(".sql")
          ? [path.join(dir, entry.name)]
          : [],
    );
  return walk(SQL_DIR);
}

/**
 * Every SECURITY DEFINER function a file creates.
 *
 * Only SECURITY DEFINER matters. An invoker-security function runs with the
 * caller's own rights, so `anon` calling it gains nothing `anon` did not already
 * have — which is why `current_auth_uid`, `current_auth_role` and
 * `current_auth_email` are deliberately callable: RLS policies invoke them as
 * the caller. Flagging those would have made this test fourteen false positives
 * deep and the real ones would have been lost in the noise.
 */
function functionsCreatedBy(source: string): string[] {
  const found: string[] = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    // The body runs to the next `create function` or the end of the file; the
    // `security definer` clause always precedes the body.
    re.lastIndex = match.index + match[0].length;
    const next = source.slice(match.index).search(/create\s+(?:or\s+replace\s+)?function/i, 1);
    const rest = source.slice(match.index + match[0].length);
    const head = rest.slice(0, Math.min(rest.length, 1200));
    if (/security\s+definer/i.test(head)) found.push(match[1].toLowerCase());
    void next;
  }
  return found;
}

function revokesFor(source: string, fn: string): boolean {
  // Either a targeted revoke, or a sweep that loops over pg_proc and revokes.
  const targeted = new RegExp(`revoke\\s+.*\\s+on\\s+function\\s+(public\\.)?${fn}\\b`, "i");
  const sweep = /revoke all on function %s from public, anon, authenticated/i;
  return targeted.test(source) || sweep.test(source);
}

describe("every migration that creates a function closes it to anon", () => {
  const offenders: Array<{ file: string; fn: string }> = [];

  for (const file of sqlFiles()) {
    const name = path.basename(file);
    if (NOT_A_MIGRATION.has(name)) continue;
    const source = readFileSync(file, "utf8");
    for (const fn of new Set(functionsCreatedBy(source))) {
      if (CLIENT_CALLABLE.has(fn)) continue;
      // A trigger function cannot be invoked over PostgREST at all.
      if (/returns\s+trigger/i.test(source.slice(source.toLowerCase().indexOf(fn)).slice(0, 400))) continue;
      if (!revokesFor(source, fn)) offenders.push({ file: name, fn });
    }
  }

  it("names every function created without a revoke beside it", () => {
    // Printed as a list so a failure says WHICH file and WHICH function, not
    // just that a count changed.
    expect(offenders.map((o) => `${o.file}: ${o.fn}`)).toEqual([]);
  });

  /**
   * NEGATIVE CONTROLS. If the matcher cannot see a function definition, or
   * cannot tell a revoked one from an unrevoked one, the assertion above is
   * decorative — which is the exact failure mode this file exists to prevent.
   */
  it("finds a SECURITY DEFINER function, and ignores an invoker one", () => {
    expect(functionsCreatedBy(
      `create or replace function public.foo(p int) returns int language sql security definer as $$ select 1 $$;`,
    )).toEqual(["foo"]);
    // Invoker security: anon calling it gains nothing anon did not have.
    expect(functionsCreatedBy(
      `create function public.bar() returns uuid language sql stable as $$ select null::uuid $$;`,
    )).toEqual([]);
    expect(functionsCreatedBy(`select 1;`)).toEqual([]);
  });

  it("tells a revoked function from an unrevoked one", () => {
    const revoked = `create function public.foo() returns int as $$ $$;
      revoke all on function public.foo() from public, anon, authenticated;`;
    const bare = `create function public.foo() returns int as $$ $$;`;

    expect(revokesFor(revoked, "foo")).toBe(true);
    expect(revokesFor(bare, "foo")).toBe(false);
    // And one function's revoke must not vouch for another's.
    expect(revokesFor(revoked, "bar")).toBe(false);
  });

  it("recognises the loop-over-pg_proc sweep as a revoke", () => {
    const sweep = `create function public.foo() returns int as $$ $$;
      execute format('revoke all on function %s from public, anon, authenticated', fn.sig);`;
    expect(revokesFor(sweep, "foo")).toBe(true);
  });
});
