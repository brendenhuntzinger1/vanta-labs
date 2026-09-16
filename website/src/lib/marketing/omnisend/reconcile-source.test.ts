import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The reconcile is the one job that can change the store's consent record on
 * the strength of what Omnisend holds, and the one that hands the whole
 * audience to Omnisend in a single pass. Neither can be exercised against a
 * database here, so the properties that make both safe are pinned in source,
 * the way codes-source.test.ts pins the coupon row:
 *
 *   * server-only, so no client bundle can pull the service key in;
 *   * the gate is asked before any database work;
 *   * the write-back is applied BEFORE the push, so an Omnisend unsubscribe
 *     goes back to Omnisend as unsubscribed on the same night;
 *   * suppressions are written in exactly the shape the unsubscribe route
 *     writes, with the source that names where they came from;
 *   * the push goes through batches, never one POST per contact;
 *   * the admin route is gated by role, and leaks nothing about a failure.
 */
const RECONCILE = readFileSync(join(process.cwd(), "src/lib/marketing/omnisend/reconcile.ts"), "utf8");
const ROUTE = readFileSync(join(process.cwd(), "src/app/api/admin/omnisend/sync/route.ts"), "utf8");
const PLAN = executable(readFileSync(join(process.cwd(), "src/lib/marketing/omnisend/reconcile-plan.ts"), "utf8"));

/** Source with comments removed: documenting a trap is not falling into it. */
function executable(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

const reconcile = executable(RECONCILE);
const route = executable(ROUTE);

function fn(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}\n");
  return rest.slice(0, end > 0 ? end : undefined);
}

describe("reconcile.ts is server-only and the planner is not", () => {
  it("imports server-only on its first line", () => {
    expect(RECONCILE.split("\n")[0]).toBe('import "server-only";');
  });

  it("keeps the decision rule pure: no server-only, no database, no environment", () => {
    expect(PLAN).not.toContain("server-only");
    expect(PLAN).not.toContain("supabase");
    expect(PLAN).not.toContain("process.env");
    expect(PLAN).not.toMatch(/^import /m);
  });

  it("takes its decisions from the planner rather than re-deciding here", () => {
    expect(reconcile).toMatch(/import \{[^}]*planWriteBack[^}]*\} from "@\/lib\/marketing\/omnisend\/reconcile-plan";/);
    expect(reconcile).toContain("planWriteBack(contacts, { suppressed,");
  });
});

describe("the order of operations", () => {
  const entry = fn(reconcile, "reconcileOmnisendContacts");

  it("asks the gate before any database work", () => {
    const gate = entry.indexOf("omnisendActive()");
    expect(gate).toBeGreaterThan(-1);
    expect(entry.slice(0, gate)).not.toContain("await ");
    expect(entry.slice(0, gate)).not.toContain("supabaseAdmin");
  });

  it("applies the write-back before the push", () => {
    const writeBack = entry.indexOf("await runWriteBack(");
    const push = entry.indexOf("await runPush(");
    expect(writeBack).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(writeBack);
  });

  it("never throws: the entry point catches, logs under the module prefix and returns a result", () => {
    expect(reconcile).toContain('const LOG = "[omnisend/reconcile]";');
    expect(entry).toMatch(/\} catch \(error\) \{\s*console\.error\(LOG, "reconcile threw", error\);\s*return \{/);
  });
});

describe("the write-back reads and advances the watermark in omnisend_sync_state", () => {
  it("keys the watermark row on contacts_reconcile and reads value.updatedAtFrom", () => {
    expect(reconcile).toContain('const SYNC_STATE_KEY = "contacts_reconcile";');
    const read = fn(reconcile, "readWatermark");
    expect(read).toMatch(/from\("omnisend_sync_state"\)\s*\.select\("value"\)\s*\.eq\("key", SYNC_STATE_KEY\)/);
    expect(read).toContain(".updatedAtFrom");
  });

  it("pages GET /contacts from the watermark, 250 a page, following paging.cursors.after", () => {
    const fetch = fn(reconcile, "fetchChangedContacts");
    expect(reconcile).toContain("const CONTACTS_PAGE_SIZE = 250;");
    expect(fetch).toContain('query.set("updatedAtFrom", watermark)');
    expect(fetch).toContain('query.set("after", after)');
    expect(fetch).toContain('method: "GET", path: `/contacts?${query.toString()}`');
    expect(fetch).toContain("parseOmnisendPaging(result.body)");
  });

  it("writes the watermark back only after a complete, refusal-free pass", () => {
    const write = fn(reconcile, "writeWatermark");
    expect(write).toMatch(/from\("omnisend_sync_state"\)\s*\.upsert\(\{ key: SYNC_STATE_KEY, value: \{ updatedAtFrom \}/);
    expect(write).toContain('onConflict: "key"');
    const run = fn(reconcile, "runWriteBack");
    expect(run).toContain("if (complete && failures === 0 && latest) await writeWatermark(latest);");
    // A dry run returns before any write, the watermark included.
    expect(run.indexOf("if (input.dryRun) {")).toBeLessThan(run.indexOf("await applySuppression("));
    expect(run.indexOf("if (input.dryRun) {")).toBeLessThan(run.indexOf("await writeWatermark("));
  });

  it("skips the write-back entirely when the suppression list cannot be read in full", () => {
    const run = fn(reconcile, "runWriteBack");
    const load = run.indexOf("await loadSuppressed()");
    const plan = run.indexOf("planWriteBack(");
    expect(load).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(load);
    expect(run.slice(load, plan)).toContain("if (!suppressed) {");
    const loader = fn(reconcile, "loadSuppressed");
    expect(loader).toContain('from("email_suppressions")');
    expect(loader).toMatch(/if \(truncated\) \{[\s\S]*?return null;/);
  });
});

describe("the write-back writes the store's own shapes", () => {
  it("suppresses exactly as the unsubscribe route does, with source omnisend", () => {
    const apply = fn(reconcile, "applySuppression");
    expect(apply).toContain('const row = { email, reason: "unsubscribed", created_at: now };');
    expect(apply).toMatch(/from\("email_suppressions"\)\s*\.upsert\(\{ \.\.\.row, source: "omnisend" \}, \{ onConflict: "email" \}\)/);
    // The retry without `source` for a database behind on the lifecycle migration.
    expect(apply).toMatch(/from\("email_suppressions"\)\s*\.upsert\(row, \{ onConflict: "email" \}\)/);
    // The account toggle mirror, by direct lookup, best-effort.
    expect(apply).toContain("await findUserByEmail(email)");
    expect(apply).toMatch(/from\("customer_preferences"\)\s*\.upsert\(\{ user_id: user\.id, marketing_emails: false, updated_at: now \}, \{ onConflict: "user_id" \}\)/);
  });

  it("mirrors a form sign-up as a guest subscriber from omnisend-form", () => {
    const apply = fn(reconcile, "applyFormSubscriber");
    expect(apply).toMatch(/from\("marketing_subscribers"\)\s*\.upsert\(\{ email, source: "omnisend-form", opted_in_at: now, unsubscribed_at: null \}, \{ onConflict: "email" \}\)/);
  });

  it("stamps an SMS opt-out on the account, keeping an existing stamp", () => {
    const apply = fn(reconcile, "applySmsOptOut");
    expect(apply).toContain("await findUserByEmail(email)");
    expect(apply).toContain('.select("sms_opted_out_at")');
    expect(apply).toContain("?.sms_opted_out_at) return false;");
    expect(apply).toContain("sms_marketing: false, sms_opted_out_at: now, updated_at: now }, { onConflict: \"user_id\" }");
  });
});

describe("the push is batched, refreshed and never per-contact", () => {
  it("sends contacts through POST /batches with endpoint contacts, 100 a batch", () => {
    expect(reconcile).toContain("const BATCH_SIZE = 100;");
    const push = fn(reconcile, "runPush");
    expect(push).toContain('path: "/batches"');
    expect(push).toContain('body: { method: "POST", endpoint: "contacts", items }');
    expect(push).toContain("chunk(list, BATCH_SIZE)");
  });

  it("never posts a single contact: no request names the contacts endpoint directly", () => {
    expect(reconcile).not.toContain('path: "/contacts"');
    expect(reconcile).not.toContain("upsertOmnisendContact");
  });

  it("does not post in a dry run", () => {
    const push = fn(reconcile, "runPush");
    const dry = push.indexOf("if (input.dryRun) {");
    const post = push.indexOf('path: "/batches"');
    expect(dry).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(dry);
    expect(push.slice(dry, post)).toContain("continue;");
  });

  it("re-signs the link token for every contact it pushes", () => {
    const build = fn(reconcile, "buildContactItem");
    expect(build).toContain("await signOmnisendLink(email, nowMs)");
    expect(build).toContain("OMNISEND_LINK_TTL_MS");
    expect(build).toContain("buildContactPayload({ ...facts, link, codes })");
  });

  it("mints a win-back code only for a subscribed buyer with no live one", () => {
    const codes = fn(reconcile, "gatherCodes");
    const lookup = codes.indexOf("findLiveContactCode(kind, email)");
    const mint = codes.indexOf('ensureContactCode("winback", email)');
    expect(lookup).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(lookup);
    expect(codes).toContain("else if (lapsedBuyer(facts, nowMs))");
    expect(reconcile).toContain('if (facts.emailConsent.status !== "subscribed") return false;');
    expect(reconcile).toContain("const WINBACK_AFTER_MS = 50 * 24 * 60 * 60 * 1000;");
  });

  it("pushes buyers without consent too, and only paid product orders count", () => {
    const buyers = fn(reconcile, "loadPaidBuyers");
    expect(buyers).toContain('.in("payment_status", Array.from(PAID_ORDER_STATUSES))');
    expect(buyers).toContain("if (!isProductPurchaseOrder(row)) continue;");
    expect(buyers).toContain("isNonMailableAddress(email)");
    const push = fn(reconcile, "runPush");
    expect(push).toContain("if (!input.audience.has(email)) targets.push(email);");
  });

  it("is bounded: a push limit and a time budget", () => {
    expect(reconcile).toContain("const DEFAULT_PUSH_LIMIT = 2000;");
    const push = fn(reconcile, "runPush");
    expect(push).toContain("targets.slice(0, input.limit)");
    expect(push).toContain("if (Date.now() > input.deadline) {");
  });
});

describe("the admin sync route", () => {
  it("is dynamic and allowed a cron-sized window", () => {
    expect(route).toContain('export const dynamic = "force-dynamic";');
    expect(route).toContain("export const maxDuration = 60;");
  });

  it("verifies the admin session, then the role, before reading the body", () => {
    const session = route.indexOf("await verifyAdminSessionFromRequest(request)");
    const role = route.indexOf("canManageEmailCampaigns(session.role)");
    const body = route.indexOf("await request.json()");
    expect(session).toBeGreaterThan(-1);
    expect(role).toBeGreaterThan(session);
    expect(body).toBeGreaterThan(role);
    expect(route).toContain('{ success: false, error: "Unauthorized" }, { status: 401 }');
    expect(route).toMatch(/canManageEmailCampaigns\(session\.role\)\) \{\s*return NextResponse\.json\(\{ success: false, error: "[^"]+" \}, \{ status: 403 \}\);/);
  });

  it("only answers POST", () => {
    expect(route).toContain("export async function POST(");
    expect(route).not.toMatch(/export async function (GET|PUT|PATCH|DELETE)\(/);
  });

  it("refuses an unknown `what` with a 400 and runs exactly the two jobs", () => {
    expect(route).toContain('if (what !== "contacts" && what !== "catalog") {');
    expect(route).toMatch(/what !== "contacts" && what !== "catalog"\) \{\s*return NextResponse\.json\([^;]*\{ status: 400 \}\);/);
    expect(route).toContain("await reconcileOmnisendContacts({ dryRun })");
    expect(route).toContain("await syncOmnisendCatalog()");
    expect(route).toContain("return NextResponse.json({ success: true, result });");
  });

  it("never leaks a stack trace or an error message to the client", () => {
    expect(route).not.toContain(".stack");
    expect(route).not.toMatch(/error:\s*(error|err|e)\.message/);
    expect(route).not.toMatch(/error:\s*String\(error\)/);
    expect(route).toMatch(/catch \(error\) \{[\s\S]*?return NextResponse\.json\(\{ success: false, error: "[^"]+" \}, \{ status: 500 \}\);/);
  });
});
