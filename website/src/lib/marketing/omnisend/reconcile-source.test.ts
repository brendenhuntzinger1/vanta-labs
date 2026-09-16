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
    const loader = fn(reconcile, "loadSuppressionReasons");
    expect(loader).toContain('from("email_suppressions")');
    expect(loader).toMatch(/if \(truncated\) \{[\s\S]*?return null;/);
  });
});

describe("the write-back writes the store's own shapes, dated when the person acted", () => {
  // Omnisend's statusChangedAt is when the person unsubscribed, opted out or
  // signed up; the reconcile's run time is when the store found out. The
  // store is stamped with the former (never later than now), through the
  // pure stampFor, so a suppression written tonight for an unsubscribe last
  // Tuesday says Tuesday.
  it("takes each address's instants from the planner and clamps them through stampFor", () => {
    const run = fn(reconcile, "runWriteBack");
    expect(run).toContain("const stamps = writeBackStamps(contacts);");
    expect(run).toContain("await applySuppression(email, stamps.get(email)?.email ?? null, input.now)");
    expect(run).toContain("await applyFormSubscriber(email, stamps.get(email)?.email ?? null, input.now)");
    expect(run).toContain("await applySmsOptOut(email, stamps.get(email)?.sms ?? null, input.now)");
    for (const name of ["applySuppression", "applyFormSubscriber", "applySmsOptOut"]) {
      expect(fn(reconcile, name), name).toContain("const at = stampFor(changedAt, now);");
    }
  });

  it("suppresses exactly as the unsubscribe route does, with source omnisend", () => {
    const apply = fn(reconcile, "applySuppression");
    expect(apply).toContain('const row = { email, reason: "unsubscribed", created_at: at };');
    expect(apply).toMatch(/from\("email_suppressions"\)\s*\.upsert\(\{ \.\.\.row, source: "omnisend" \}, \{ onConflict: "email" \}\)/);
    // The retry without `source` for a database behind on the lifecycle migration.
    expect(apply).toMatch(/from\("email_suppressions"\)\s*\.upsert\(row, \{ onConflict: "email" \}\)/);
    // The account toggle mirror, by direct lookup, best-effort; updated_at is
    // when the row changed, which is now.
    expect(apply).toContain("await findUserByEmail(email)");
    expect(apply).toMatch(/from\("customer_preferences"\)\s*\.upsert\(\{ user_id: user\.id, marketing_emails: false, updated_at: now \}, \{ onConflict: "user_id" \}\)/);
  });

  it("mirrors a form sign-up as a guest subscriber from omnisend-form, and never re-opens a site opt-out it does not postdate", () => {
    const apply = fn(reconcile, "applyFormSubscriber");
    // The existing row first: a guest who unsubscribed on the site is absent
    // from the audience, so the planner offers them as a new subscriber
    // whenever Omnisend still says subscribed. Only a subscribe Omnisend
    // dates AFTER the site's opt-out (a real re-subscribe through the form)
    // may null unsubscribed_at; no date, or an earlier one, writes nothing.
    expect(apply).toMatch(/from\("marketing_subscribers"\)\s*\.select\("unsubscribed_at"\)\s*\.eq\("email", email\)\s*\.maybeSingle\(\)/);
    expect(apply).toMatch(/if \(error\) \{[\s\S]*?return "failed";/);
    expect(apply).toContain('if (existing?.unsubscribed_at && !isLaterInstant(changedAt, existing.unsubscribed_at)) return "nothing";');
    expect(apply).toMatch(/from\("marketing_subscribers"\)\s*\.upsert\(\{ email, source: "omnisend-form", opted_in_at: at, unsubscribed_at: null \}, \{ onConflict: "email" \}\)/);
    expect(apply).toMatch(/if \(writeError\) \{[\s\S]*?return "failed";/);
    const run = fn(reconcile, "runWriteBack");
    expect(run).toMatch(/if \(form === "applied"\) counts\.formSubscribers \+= 1;\s*else if \(form === "failed"\) failures \+= 1;/);
  });

  it("stamps an SMS opt-out on the account, keeping an existing stamp, and counts a refused write as a failure", () => {
    const apply = fn(reconcile, "applySmsOptOut");
    expect(apply).toContain("await findUserByEmail(email)");
    expect(apply).toContain('if (!user?.id) return "nothing";');
    expect(apply).toContain('.select("sms_opted_out_at")');
    expect(apply).toMatch(/if \(error\) \{[\s\S]*?return "failed";/);
    expect(apply).toContain('?.sms_opted_out_at) return "nothing";');
    expect(apply).toContain("sms_marketing: false, sms_opted_out_at: at, updated_at: now }, { onConflict: \"user_id\" }");
    expect(apply).toMatch(/if \(writeError\) \{[\s\S]*?return "failed";/);
    expect(apply).toMatch(/\} catch \(error\) \{[\s\S]*?return "failed";/);
    // A refused opt-out write holds the watermark like every other refusal,
    // so the same contact is re-read tomorrow; "nothing" is not a failure.
    const run = fn(reconcile, "runWriteBack");
    expect(run).toMatch(/if \(sms === "applied"\) counts\.smsOptOuts \+= 1;\s*else if \(sms === "failed"\) failures \+= 1;/);
    expect(run).toContain("if (complete && failures === 0 && latest) await writeWatermark(latest);");
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
    expect(build).toContain("buildContactPayload({ ...facts, link, codes, recoveryGift })");
  });

  it("is honest about the recovery gift: preserved while a live offer row exists, cleared when none is, never cleared on a guess", () => {
    // The gift's claim link carries a bearer token that customer-offers.ts
    // never persists, so the reconcile cannot rebuild the object the sweep
    // pushed. What it can do is tell Omnisend when the gift is GONE: an
    // expired, redeemed or revoked row clears the five properties (null),
    // and a live row leaves them as the sweep set them (undefined, omitted).
    const build = fn(reconcile, "buildContactItem");
    expect(build).toContain("const recoveryGift = await liveRecoveryGift(email, nowMs);");
    const gift = fn(reconcile, "liveRecoveryGift");
    expect(gift).toMatch(
      /from\("customer_offers"\)\s*\.select\("id"\)\s*\.eq\("offer_key", RECOVERY_GIFT_OFFER_KEY\)\s*\.eq\("email", email\)\s*\.is\("revoked_at", null\)\s*\.is\("redeemed_at", null\)\s*\.gt\("expires_at", new Date\(nowMs\)\.toISOString\(\)\)\s*\.limit\(1\)/,
    );
    expect(gift).toMatch(/if \(error\) \{[\s\S]*?return undefined;/);
    expect(gift).toMatch(/\} catch \(error\) \{[\s\S]*?return undefined;/);
    expect(gift).toContain("return Array.isArray(data) && data.length > 0 ? undefined : null;");
    expect(reconcile).toMatch(/import \{ RECOVERY_GIFT_OFFER_KEY \} from "@\/lib\/cart-recovery-offers";/);
  });

  it("counts an address whose store record could not be read, and reports it rather than dropping it silently", () => {
    // collectContactFacts answers null when the suppression store could not
    // be read (fail closed means do not push); the address is not in any
    // batch, and the report has to say so.
    const push = fn(reconcile, "runPush");
    expect(push).toMatch(/if \(!entry\) \{\s*outcome\.unreadable \+= 1;\s*continue;\s*\}/);
    const entry = fn(reconcile, "reconcileOmnisendContacts");
    expect(entry).toContain("if (push.unreadable > 0) report.unresolved.push(`${push.unreadable} address(es) skipped: store record unreadable; re-read next run`);");
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
    expect(push).toContain("orderPushTargets(input.audience, buyers)");
  });

  it("is bounded: a push limit and a time budget", () => {
    expect(reconcile).toContain("const DEFAULT_PUSH_LIMIT = 2000;");
    const push = fn(reconcile, "runPush");
    expect(push).toContain("targets.slice(0, input.limit)");
    expect(push).toContain("if (Date.now() > input.deadline) {");
  });

  it("orders its targets through the pure planner, and exports its loaders for the snapshot", () => {
    const push = fn(reconcile, "runPush");
    expect(push).toContain("orderPushTargets(input.audience, buyers)");
    expect(reconcile).toContain("export async function loadAudience(");
    expect(reconcile).toContain("export async function loadPaidBuyers(");
    expect(reconcile).toContain("export async function loadSuppressionReasons(");
    expect(reconcile).toContain("export async function loadWithdrawnConsent(");
    expect(reconcile).toContain("export async function mapWithConcurrency<");
  });

  it("loads withdrawn consent for the snapshot: guest opt-outs and unticked account boxes, resolved like the audience, in full or not at all", () => {
    // A guest whose unsubscribed_at is set with no order and no suppression
    // row, and an account with marketing_emails = false, are in neither the
    // audience nor the suppression list — and they are exactly the people a
    // re-subscribe would harm, so the snapshot has to hold them.
    const loader = fn(reconcile, "loadWithdrawnConsent");
    expect(loader).toMatch(/from\("marketing_subscribers"\)\s*\.select\("email"\)\s*\.not\("unsubscribed_at", "is", null\)/);
    expect(loader).toMatch(/from\("customer_preferences"\)\s*\.select\("user_id"\)\s*\.eq\("marketing_emails", false\)/);
    expect(loader).toContain("await resolveAccountEmails(");
    expect(loader).toMatch(/if \(guestsTruncated \|\| accountsTruncated\) \{[\s\S]*?return null;/);
    expect(loader).toMatch(/\} catch \(error\) \{[\s\S]*?return null;/);
    expect(reconcile).toMatch(/import \{[^}]*resolveAccountEmails[^}]*\} from "@\/lib\/email\/audience";/);
  });

  it("derives the suppression set from the reasons map, which is read in full or not at all", () => {
    const reasons = fn(reconcile, "loadSuppressionReasons");
    expect(reasons).toMatch(/from\("email_suppressions"\)\s*\.select\("email, reason"\)/);
    expect(reasons).toMatch(/if \(truncated\) \{[\s\S]*?return null;/);
    const loader = fn(reconcile, "loadSuppressed");
    expect(loader).toContain("await loadSuppressionReasons()");
    expect(loader).toContain("new Set(reasons.keys())");
  });
});

describe("the migration is accountable: report, batch polling and the cutoff", () => {
  const entry = fn(reconcile, "reconcileOmnisendContacts");

  it("returns a report built from the pure shape, with counts and batch ids only", () => {
    expect(reconcile).toContain("report: emptyReconcileReport()");
    expect(reconcile).toMatch(/report: OmnisendReconcileReport;/);
  });

  it("counts Omnisend's contacts by paging GET /contacts at 250, at most 40 pages, and says when it capped", () => {
    const count = fn(reconcile, "countOmnisendContacts");
    expect(reconcile).toContain("const MAX_CONTACT_PAGES = 40;");
    expect(count).toContain("for (let page = 0; page < MAX_CONTACT_PAGES; page += 1)");
    expect(count).toContain("limit: String(CONTACTS_PAGE_SIZE)");
    expect(count).toContain('method: "GET", path: `/contacts?${query.toString()}`');
    expect(count).toContain("countContactsOnPage(result.body)");
    expect(count).toContain("return { count, capped: true, complete: false };");
    // Before the write-back, so the "before" number predates every change this run makes.
    const before = entry.indexOf("await countOmnisendContacts()");
    const writeBack = entry.indexOf("await runWriteBack(");
    expect(before).toBeGreaterThan(-1);
    expect(before).toBeLessThan(writeBack);
  });

  it("remembers every batch id the push submitted, merged onto a FRESH read of the row, or refuses to write", () => {
    const push = fn(reconcile, "runPush");
    const post = push.indexOf('path: "/batches"');
    const parse = push.indexOf("parseBatchSubmission(result.body)");
    expect(parse).toBeGreaterThan(post);
    expect(push).toContain("outcome.batchIds.push(submission.id)");
    // The row read at run start is stale by write time (another run, a
    // refused poll write), and readBatchRecords answers null when the row
    // cannot be read: writing over either would drop unfinished ids.
    const fresh = entry.indexOf("const fresh = await readBatchRecords();");
    const write = entry.indexOf("await writeBatchRecords(rememberBatches(mergeBatchRecords(fresh, records), push.submissions, now))");
    expect(fresh).toBeGreaterThan(entry.indexOf("await runPush("));
    expect(write).toBeGreaterThan(fresh);
    expect(entry.slice(fresh, write)).toMatch(/if \(fresh === null\) \{[\s\S]*?report\.unresolved\.push\(`\$\{push\.submissions\.length\} batch id\(s\) not remembered: batches row unreadable; the next run cannot poll them`\);/);
    expect(entry).not.toContain("rememberBatches(records, push.submissions, now)");
  });

  it("says when the after-count is incomplete, as it does for the before-count", () => {
    const before = entry.indexOf("const before = await countOmnisendContacts()");
    const after = entry.indexOf("const after = await countOmnisendContacts()");
    expect(before).toBeGreaterThan(-1);
    expect(after).toBeGreaterThan(before);
    expect(entry.slice(before, after)).toContain('report.unresolved.push("omnisend contact count incomplete: a contacts page was refused")');
    expect(entry.slice(after)).toContain("if (after.capped) report.unresolved.push(`omnisend contact count capped at ${MAX_CONTACT_PAGES} pages (after)`);");
    expect(entry.slice(after)).toContain('else if (!after.complete) report.unresolved.push("omnisend contact count incomplete (after): a contacts page was refused");');
  });

  it("polls the unfinished batches from the last runs before pushing, and folds their errors into unresolved", () => {
    const poll = fn(reconcile, "pollBatches");
    expect(poll).toContain("const records = (await readBatchRecords()) ?? [];");
    expect(poll).toContain("batchUnfinished(record)");
    expect(poll).toContain("path: `/batches/${encodeURIComponent(record.id)}`");
    expect(poll).toContain("applyBatchRead(record, parseBatchStatus(result.body), input.now)");
    expect(poll).toContain("retries: 0");
    const polled = entry.indexOf("await pollBatches(");
    const push = entry.indexOf("await runPush(");
    expect(polled).toBeGreaterThan(-1);
    expect(polled).toBeLessThan(push);
    expect(entry).toContain("report.unresolved.push(...batchNotes(");
  });

  it("records the migration cutoff once, before the first live push, never on a dry run", () => {
    const cutoff = entry.indexOf("await recordMigrationCutoff(now)");
    const push = entry.indexOf("await runPush(");
    expect(cutoff).toBeGreaterThan(-1);
    expect(cutoff).toBeLessThan(push);
    expect(entry.slice(cutoff - 40, cutoff)).toContain("if (!dryRun)");
    expect(entry.match(/recordMigrationCutoff\(/g)).toHaveLength(1);
  });

  it("never logs an address: the contact build failure names the domain only", () => {
    const build = fn(reconcile, "buildContactItem");
    expect(build).not.toContain("{ email, error }");
    expect(build).toContain("domain: email.slice(email.indexOf(\"@\") + 1)");
    // No log object carries the address as a value: neither the shorthand
    // `{ email }` nor `{ anything: email }`. Deriving the domain from it is fine.
    const logs = reconcile.match(/console\.\w+\([^\n]*/g) ?? [];
    for (const line of logs) {
      expect(line).not.toMatch(/[{,]\s*email\s*[,}]/);
      expect(line).not.toMatch(/:\s*email\s*[,}]/);
    }
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

  it("refuses an unknown `what` with a 400 and runs exactly the three jobs", () => {
    expect(route).toContain('if (what !== "contacts" && what !== "catalog" && what !== "snapshot") {');
    expect(route).toMatch(/what !== "contacts" && what !== "catalog" && what !== "snapshot"\) \{\s*return NextResponse\.json\([^;]*\{ status: 400 \}\);/);
    expect(route).toContain("await reconcileOmnisendContacts({ dryRun })");
    expect(route).toContain("await syncOmnisendCatalog()");
    expect(route).toContain("await snapshotOmnisendConsent({ label })");
    expect(route).toContain("return NextResponse.json({ success: true, result });");
  });

  it("labels a snapshot from the body, defaulting to pre-migration-<date>, and refuses a label it cannot store", () => {
    expect(route).toContain('typeof body?.label === "string" && body.label.trim() ? body.label.trim() : defaultSnapshotLabel()');
    expect(route).toMatch(/if \(what === "snapshot" && !isValidSnapshotLabel\(label\)\) \{\s*return NextResponse\.json\([^;]*\{ status: 400 \}\);/);
    const validate = route.indexOf("isValidSnapshotLabel(label)");
    const run = route.indexOf("await snapshotOmnisendConsent({ label })");
    expect(validate).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(validate);
  });

  it("never leaks a stack trace or an error message to the client", () => {
    expect(route).not.toContain(".stack");
    expect(route).not.toMatch(/error:\s*(error|err|e)\.message/);
    expect(route).not.toMatch(/error:\s*String\(error\)/);
    expect(route).toMatch(/catch \(error\) \{[\s\S]*?return NextResponse\.json\(\{ success: false, error: "[^"]+" \}, \{ status: 500 \}\);/);
  });
});
