import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The three Omnisend cron jobs, pinned in the source:
 *
 *   * each asks the gate BEFORE any database read, so a preview deployment or
 *     a build without a key returns having touched nothing;
 *   * none of them sends an event itself — the backstop goes through
 *     onOrderPaid, which is the only thing that holds the exactly-once ledger
 *     claim, and the two cadence jobs only decide WHEN to call the modules
 *     that already exist;
 *   * the cadence record lives in omnisend_sync_state under its own key, read
 *     and written through the shared helper rather than a second copy of the
 *     reconcile's watermark code;
 *   * the sweep route registers all three under the labels an operator reads.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

function executable(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

const SWEEPS_RAW = read("src/lib/marketing/omnisend/sweeps.ts");
const SWEEPS = executable(SWEEPS_RAW);
const SYNC_STATE_RAW = read("src/lib/marketing/omnisend/sync-state.ts");
const SYNC_STATE = executable(SYNC_STATE_RAW);
const ROUTE = executable(read("src/app/api/cron/sweep/route.ts"));

function fn(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `${declaration} not found`).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}\n");
  return rest.slice(0, end > 0 ? end : undefined);
}

const JOBS = [
  "export async function omnisendOrderBackstop(",
  "export async function omnisendCatalogSyncJob(",
  "export async function omnisendContactsReconcileJob(",
] as const;

describe("sweeps.ts and sync-state.ts are server-only", () => {
  it("import server-only on their first line", () => {
    expect(SWEEPS_RAW.split("\n")[0]).toBe('import "server-only";');
    expect(SYNC_STATE_RAW.split("\n")[0]).toBe('import "server-only";');
  });
});

describe("every job asks the gate first", () => {
  for (const declaration of JOBS) {
    it(`${declaration.replace("export async function ", "").replace("(", "")} calls omnisendActive() before any await or database access`, () => {
      const body = fn(SWEEPS, declaration);
      const gate = body.indexOf("omnisendActive()");
      expect(gate).toBeGreaterThan(-1);
      const before = body.slice(0, gate);
      expect(before).not.toContain("await ");
      expect(before).not.toContain("supabaseAdmin");
      expect(before).not.toContain("readSyncState(");
      // And returns on refusal with the reason, not silently.
      expect(body.slice(gate)).toMatch(/if \(!gate\.active\) return \{[^}]*skipped: gate\.reason/);
    });
  }
});

describe("no job talks to Omnisend directly", () => {
  it("only order-hooks.ts sends order events; the cadence jobs call the existing modules", () => {
    expect(SWEEPS).not.toContain("sendOmnisendEvent");
    expect(SWEEPS).not.toContain("omnisendRequest");
    expect(SWEEPS).not.toContain("buildOrderEvent");
    expect(SWEEPS).not.toContain("upsertOmnisendContact");
    expect(SWEEPS).toMatch(/import \{ onOrderPaid \} from "@\/lib\/marketing\/omnisend\/order-hooks";/);
    expect(SWEEPS).toMatch(/import \{[^}]*\bsyncOmnisendCatalog\b[^}]*\} from "@\/lib\/marketing\/omnisend\/catalog-sync";/);
    expect(SWEEPS).toMatch(/import \{[^}]*\breconcileOmnisendContacts\b[^}]*\} from "@\/lib\/marketing\/omnisend\/reconcile";/);
  });

  it("the backstop counts a delivery only from onOrderPaid's own answer", () => {
    const backstop = fn(SWEEPS, JOBS[0]);
    expect(backstop).toContain("await onOrderPaid(candidate.order_id)");
    expect(backstop).toContain("if (delivered) sent += 1;");
  });
});

describe("the backstop is bounded and retries only dead claims", () => {
  const backstop = fn(SWEEPS, JOBS[0]);

  it("reads paid product orders from the last seven days, fifty a run", () => {
    expect(SWEEPS).toContain("const OMNISEND_BACKSTOP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;");
    expect(SWEEPS).toContain("const DEFAULT_BACKSTOP_LIMIT = 50;");
    expect(backstop).toContain('.in("payment_status", Array.from(PAID_ORDER_STATUSES))');
    expect(backstop).toContain("ordersNeedingOmnisendPaid(");
    expect(backstop).toContain("pending.slice(0, limit)");
  });

  it("releases only stale undelivered claims, through the ledger's own release, before retrying", () => {
    const release = backstop.indexOf("staleOmnisendClaims(");
    const retry = backstop.indexOf("await onOrderPaid(");
    expect(release).toBeGreaterThan(-1);
    expect(retry).toBeGreaterThan(release);
    expect(backstop).toContain("omnisendLedger(claim.entityId).releaseSend(claim.eventName)");
    // Never a raw delete on the ledger table from here.
    expect(backstop).not.toMatch(/from\("omnisend_events_sent"\)\s*\.delete\(/);
  });

  it("never throws: the body is caught, logged under the module prefix, and answered", () => {
    expect(SWEEPS).toContain('const LOG = "[omnisend/sweeps]";');
    expect(backstop).toMatch(/\} catch \(error\) \{\s*console\.error\(LOG, "order backstop threw", error\);\s*return \{/);
  });
});

describe("the cadence jobs keep their record in omnisend_sync_state", () => {
  it("shares one read/write helper rather than re-implementing the reconcile's watermark", () => {
    expect(SWEEPS).toMatch(/import \{ readSyncState, writeSyncState \} from "@\/lib\/marketing\/omnisend\/sync-state";/);
    expect(SWEEPS).not.toContain('from("omnisend_sync_state")');
    const readState = fn(SYNC_STATE, "export async function readSyncState");
    expect(readState).toMatch(/from\("omnisend_sync_state"\)\s*\.select\("value"\)\s*\.eq\("key", stateKey\)/);
    const writeState = fn(SYNC_STATE, "export async function writeSyncState");
    expect(writeState).toMatch(/from\("omnisend_sync_state"\)\s*\.upsert\(\{ key: stateKey, value, updated_at: /);
    expect(writeState).toContain('onConflict: "key"');
  });

  it("uses distinct keys from the reconcile's watermark, at six hours and twenty-four hours", () => {
    expect(SWEEPS).toContain('const CATALOG_SYNC_KEY = "catalog_sync";');
    expect(SWEEPS).toContain('const CONTACTS_RECONCILE_KEY = "contacts_reconcile_cadence";');
    expect(SWEEPS).not.toContain('"contacts_reconcile"');
    expect(SWEEPS).toContain("const CATALOG_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;");
    expect(SWEEPS).toContain("const CONTACTS_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;");
  });

  for (const [declaration, key, runner] of [
    [JOBS[1], "CATALOG_SYNC_KEY", "await syncOmnisendCatalog()"],
    [JOBS[2], "CONTACTS_RECONCILE_KEY", "await reconcileOmnisendContacts()"],
  ] as const) {
    it(`${declaration.replace("export async function ", "").replace("(", "")} decides with cadenceDecision, runs, then stamps lastRunAt`, () => {
      const body = fn(SWEEPS, declaration);
      const read = body.indexOf(`readSyncState<CadenceRecord>(${key}, LOG)`);
      const decide = body.indexOf("cadenceDecision({");
      const run = body.indexOf(runner);
      const write = body.indexOf(`writeSyncState(${key}, { lastRunAt`);
      expect(read).toBeGreaterThan(-1);
      expect(decide).toBeGreaterThan(read);
      expect(run).toBeGreaterThan(decide);
      expect(write).toBeGreaterThan(run);
      expect(body).toMatch(/if \(!decision\.due\) return \{[^}]*skipped: decision\.skipped/);
    });
  }
});

describe("the sweep route registers all three", () => {
  it("imports the three jobs from sweeps.ts", () => {
    expect(ROUTE).toMatch(
      /import \{\s*omnisendCatalogSyncJob,\s*omnisendContactsReconcileJob,\s*omnisendOrderBackstop,?\s*\} from "@\/lib\/marketing\/omnisend\/sweeps";/,
    );
  });

  it("keys and labels them as one contiguous block", () => {
    const backstop = ROUTE.indexOf('omnisendOrderBackstop: { label: "omnisend_order_backstop", run: omnisendOrderBackstop },');
    const catalog = ROUTE.indexOf('omnisendCatalogSync: { label: "omnisend_catalog_sync", run: omnisendCatalogSyncJob },');
    const reconcile = ROUTE.indexOf('omnisendContactsReconcile: { label: "omnisend_contacts_reconcile", run: omnisendContactsReconcileJob },');
    expect(backstop).toBeGreaterThan(-1);
    expect(catalog).toBeGreaterThan(backstop);
    expect(reconcile).toBeGreaterThan(catalog);
    // Contiguous: nothing but these three between the first and the last.
    const block = ROUTE.slice(backstop, reconcile);
    expect(block.match(/[A-Za-z]+: \{ label: "/g)).toEqual([
      'omnisendOrderBackstop: { label: "',
      'omnisendCatalogSync: { label: "',
    ]);
  });
});
