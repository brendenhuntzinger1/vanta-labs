#!/usr/bin/env node
// ---------------------------------------------------------------------------
// DRIVES THE ADMIN EMAIL PAGE THE WAY AN OPERATOR DOES.
//
// The automation CTA was editable in the database, in the PATCH payload the
// admin client already sent, and in the send path — and there was no input
// rendered for it, so the only way to change a win-back's button was to edit
// SQL. This proves the fix end to end against the local harness:
//
//   * each of the four automations takes its own CTA text and destination,
//     and they survive a save and a reload;
//   * the preview renders the button that was typed, in the real template;
//   * clearing both fields removes the button rather than silently restoring
//     "SHOP NOW", which is what the API used to do;
//   * one automation's CTA cannot leak into another's;
//   * an off-site destination is refused;
//   * the tracked link redirects to the right place AND records the click.
//
// Local harness only. Refuses to run against anything else — see the guard.
//
//   node scripts/qa-automation-cta.mjs
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const SHOTS = process.env.QA_SHOT_DIR ?? "/tmp/vanta-qa/cta";
const USER = process.env.QA_ADMIN_USER ?? "vantaqa";
const PASS = process.env.QA_ADMIN_PASS ?? "HarnessAdmin123!";
const CODE = process.env.QA_ADMIN_CODE ?? "123456";

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. Local harness only.`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB });
const q = (text, params) => pool.query(text, params);

const results = [];
let section_ = "";
const section = (t) => { section_ = t; console.log(`\n${t}`); };
const assert = (c, m) => { if (!c) throw new Error(m); };

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ section: section_, name, status: "pass", detail });
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (error) {
    const message = String(error?.message ?? error).split("\n")[0].slice(0, 300);
    results.push({ section: section_, name, status: "fail", detail: message });
    console.log(`  FAIL  ${name}\n        ${message}`);
  }
}

// The four automations, each given a DISTINCT label and destination so a value
// bleeding from one card into another is visible rather than plausible.
const PLAN = [
  { key: "welcome_no_purchase", label: "CLAIM 15% OFF", path: "/products?welcome=1" },
  { key: "post_purchase", label: "EXPLORE VANTA", path: "/products?reorder=1" },
  { key: "winback_30", label: "SEE WHAT'S NEW", path: "/products?new=1" },
  { key: "winback_60", label: "CLAIM YOUR FREE GHK-CU", path: "/products?ghkcu=1" },
];

const consoleErrors = [];
const failedRequests = [];
const httpProblems = [];

/** POST as the page itself, so the browser sets a same-origin Origin header.
 *  page.request runs in its own context and sends none, which the app
 *  correctly refuses — that refusal is the CSRF guard working, not a bug. */
async function postAsPage(page, url, data) {
  return page.evaluate(async ([u, d]) => {
    const res = await fetch(u, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(d),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, [url, data]);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--no-sandbox", "--ssl-version-max=tls1.2"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 200));
  });
  page.on("response", (res) => {
    if (res.status() >= 400) httpProblems.push(`${res.status()} ${res.request().method()} ${res.url()}`);
  });
  page.on("requestfailed", (req) => {
    failedRequests.push(`${req.method()} ${req.url().slice(0, 120)} — ${req.failure()?.errorText}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400 && !res.url().includes("/api/email/automation-click")) {
      failedRequests.push(`${res.status()} ${res.url().slice(0, 120)}`);
    }
  });

  // --- sign in -------------------------------------------------------------
  section("1. Admin sign-in");
  await step("reaches /admin/email as a signed-in admin", async () => {
    await page.goto(`${BASE}/vault`, { waitUntil: "domcontentloaded" });
    const inputs = page.locator("form input:visible");
    await inputs.nth(0).fill(USER);
    await inputs.nth(1).fill(PASS);
    await inputs.nth(2).fill(CODE);
    await page.getByRole("button", { name: /enter/i }).click();
    await page.waitForURL(/\/admin/, { timeout: 20_000 });
    await page.goto(`${BASE}/admin/email`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Automated sequences" }).waitFor({ timeout: 20_000 });
    return page.url();
  });

  let transactionalOrderId = null;

  const labelBox = (key) => page.locator(`[data-testid="automation-${key}-cta-label"]`);
  const pathBox = (key) => page.locator(`[data-testid="automation-${key}-cta-path"]`);
  const saveBtn = (key) => page.locator(`[data-testid="automation-${key}-save"]`);
  const previewBtn = (key) => page.locator(`[data-testid="automation-${key}-preview"]`);

  async function saveAutomation(key) {
    await saveBtn(key).click();
    await page.getByText(/^Saved "/).waitFor({ timeout: 15_000 });
  }

  // --- the fields exist and take a value -----------------------------------
  section("2. CTA fields are editable per automation");
  for (const item of PLAN) {
    await step(`${item.key}: set CTA text and destination, save`, async () => {
      await labelBox(item.key).fill(item.label);
      await pathBox(item.key).fill(item.path);
      await saveAutomation(item.key);
      return `${item.label} → ${item.path}`;
    });
  }

  // --- persistence across a reload -----------------------------------------
  section("3. Values persist across a reload");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Automated sequences" }).waitFor();
  for (const item of PLAN) {
    await step(`${item.key}: reloaded page shows what was saved`, async () => {
      const label = await labelBox(item.key).inputValue();
      const path = await pathBox(item.key).inputValue();
      assert(label === item.label, `label is ${JSON.stringify(label)}, expected ${JSON.stringify(item.label)}`);
      assert(path === item.path, `path is ${JSON.stringify(path)}, expected ${JSON.stringify(item.path)}`);
      return `${label} → ${path}`;
    });
  }

  await step("the database agrees with the form", async () => {
    const { rows } = await q("select key, cta_label, cta_path from email_automations order by key");
    for (const item of PLAN) {
      const row = rows.find((r) => r.key === item.key);
      assert(row, `${item.key} missing from email_automations`);
      assert(row.cta_label === item.label, `${item.key} stored label ${JSON.stringify(row.cta_label)}`);
      assert(row.cta_path === item.path, `${item.key} stored path ${JSON.stringify(row.cta_path)}`);
    }
    return `${rows.length} rows checked`;
  });

  // --- one automation cannot use another's CTA ------------------------------
  section("4. Automations are isolated from each other");
  await step("all four labels and destinations are distinct in the DOM", async () => {
    const labels = [], paths = [];
    for (const item of PLAN) {
      labels.push(await labelBox(item.key).inputValue());
      paths.push(await pathBox(item.key).inputValue());
    }
    assert(new Set(labels).size === 4, `labels collided: ${JSON.stringify(labels)}`);
    assert(new Set(paths).size === 4, `paths collided: ${JSON.stringify(paths)}`);
    return labels.join(" | ");
  });

  await step("editing one card leaves the other three untouched", async () => {
    await labelBox("winback_30").fill("TEMPORARY EDIT");
    for (const other of PLAN.filter((p) => p.key !== "winback_30")) {
      const label = await labelBox(other.key).inputValue();
      assert(label === other.label, `${other.key} changed to ${JSON.stringify(label)}`);
    }
    await labelBox("winback_30").fill(PLAN[2].label);  // put it back
    return "3 siblings unchanged";
  });

  // --- preview renders the real template -----------------------------------
  section("5. Preview renders the CTA that was typed");
  for (const item of PLAN) {
    await step(`${item.key}: preview shows its own button`, async () => {
      // Close whatever is open first. Only one preview exists at a time by
      // design, and while the previous panel is still mounted a bare testid
      // matches IT in DOM order rather than the card just clicked.
      const open = page.locator(`[data-testid="automation-preview-close"]`);
      if (await open.count()) await open.first().click();
      await previewBtn(item.key).click();
      const frame = page.locator(`[data-testid="automation-${item.key}-preview-panel"] [data-testid="automation-preview-frame"]`);
      await frame.waitFor({ timeout: 15_000 });
      const html = await frame.getAttribute("srcdoc");
      assert(html, "preview frame has no srcdoc");
      assert(html.includes(item.label.replace(/'/g, "&#39;").replace(/&/g, "&amp;")) || html.includes(item.label),
        `preview does not contain ${JSON.stringify(item.label)}`);
      assert(html.includes(`href="${BASE}${item.path.replace(/&/g, "&amp;")}"`) || html.includes(item.path.split("?")[0]),
        `preview does not link to ${item.path}`);
      // The new button shape, not the old bare anchor.
      assert(html.includes('bgcolor="#F2C94C"'), "preview button is not the gold primary variant");
      assert(html.includes("mso-padding-alt:16px 28px"), "preview button carries no Outlook padding");
      assert(/<td align="center" style="padding:28px 32px 4px;">/.test(html), "CTA row is not centred at the card inset");
      return "gold, centred, Outlook-safe";
    });
  }

  // --- screenshots ---------------------------------------------------------
  section("6. Desktop and mobile rendering");
  await step("desktop screenshot of the automations panel", async () => {
    await previewBtn("winback_60").click();
    await page.locator(`[data-testid="automation-preview-frame"]`).waitFor();
    await page.locator(`[data-testid="automation-winback_60-stats"]`).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/admin-desktop.png`, fullPage: false });
    return `${SHOTS}/admin-desktop.png`;
  });

  await step("the preview iframe renders the email at 390px", async () => {
    await page.locator(`[data-testid="automation-preview-mobile"]`).click();
    const frame = page.locator(`[data-testid="automation-preview-frame"]`);
    const box = await frame.boundingBox();
    assert(box && Math.round(box.width) === 390, `preview frame is ${box?.width}px wide, expected 390`);
    await page.screenshot({ path: `${SHOTS}/preview-mobile-390.png` });
    return `iframe ${Math.round(box.width)}px`;
  });

  await step("admin page at 390x844 has no horizontal overflow", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Automated sequences" }).waitFor();
    await labelBox("winback_60").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/admin-mobile-390.png`, fullPage: false });
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflow <= 1, `page scrolls horizontally by ${overflow}px`);
    return `overflow ${overflow}px`;
  });

  // Render the email itself standalone, at both widths, so the BUTTON can be
  // measured rather than eyeballed through the admin chrome.
  await step("the rendered button is a >=44px tap target on a phone", async () => {
    const { rows } = await q("select cta_label, cta_path from email_automations where key='winback_60'");
    const { body } = await postAsPage(page, "/api/admin/email/automations/preview", {
      key: "winback_60", subject: "Still researching?", headline: "Come back",
      body: "Here is what is waiting.", ctaLabel: rows[0].cta_label, ctaPath: rows[0].cta_path,
    });
    assert(body?.success, `preview API said ${JSON.stringify(body?.error ?? body)}`);
    writeFileSync(`${SHOTS}/email-winback_60.html`, body.html);

    const mail = await context.newPage();
    await mail.setViewportSize({ width: 390, height: 844 });
    await mail.setContent(body.html);
    const button = mail.locator("a[href*='/products']").first();
    const box = await button.boundingBox();
    assert(box, "no CTA anchor found in the rendered email");
    assert(box.height >= 44, `button is ${Math.round(box.height)}px tall, under the 44px minimum`);
    await mail.screenshot({ path: `${SHOTS}/email-mobile-390.png`, fullPage: true });
    await mail.setViewportSize({ width: 1000, height: 900 });
    await mail.screenshot({ path: `${SHOTS}/email-desktop.png`, fullPage: true });
    await mail.close();
    return `${Math.round(box.width)}x${Math.round(box.height)}px`;
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Automated sequences" }).waitFor();

  // --- blank CTA -----------------------------------------------------------
  section("7. A blank CTA removes the button");
  await step("clearing both boxes saves as blank rather than 'SHOP NOW'", async () => {
    await labelBox("post_purchase").fill("");
    await pathBox("post_purchase").fill("");
    await saveAutomation("post_purchase");
    const { rows } = await q("select cta_label, cta_path from email_automations where key='post_purchase'");
    assert(rows[0].cta_label === "", `stored label is ${JSON.stringify(rows[0].cta_label)}`);
    assert(rows[0].cta_path === "", `stored path is ${JSON.stringify(rows[0].cta_path)}`);
    return "both stored blank";
  });

  await step("the cleared value survives a reload", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Automated sequences" }).waitFor();
    assert((await labelBox("post_purchase").inputValue()) === "", "label came back populated");
    assert((await pathBox("post_purchase").inputValue()) === "", "path came back populated");
    return "still blank";
  });

  await step("the preview renders cleanly with no button at all", async () => {
    await previewBtn("post_purchase").click();
    const frame = page.locator(`[data-testid="automation-preview-frame"]`);
    await frame.waitFor({ timeout: 15_000 });
    const html = await frame.getAttribute("srcdoc");
    assert(!html.includes("border-radius:999px"), "an empty button shell was rendered");
    assert(!html.includes("bgcolor=\"#F2C94C\""), "a gold pill was rendered with no label");
    assert(html.includes("Vanta Labs"), "the message body did not render");
    writeFileSync(`${SHOTS}/email-no-cta.html`, html);
    const mail = await context.newPage();
    await mail.setViewportSize({ width: 390, height: 844 });
    await mail.setContent(html);
    await mail.screenshot({ path: `${SHOTS}/email-no-cta-390.png`, fullPage: true });
    await mail.close();
    return "no button, body intact";
  });

  await step("half a button is refused", async () => {
    await labelBox("post_purchase").fill("SHOP NOW");
    await pathBox("post_purchase").fill("");
    await saveBtn("post_purchase").click();
    await page.getByText(/Set both the button text and its destination/).waitFor({ timeout: 15_000 });
    return "rejected with a usable message";
  });

  // --- validation ----------------------------------------------------------
  section("8. Destination validation");
  await step("an off-site destination is refused", async () => {
    await labelBox("post_purchase").fill("EXPLORE VANTA");
    await pathBox("post_purchase").fill("https://evil.example.com/pwned");
    await saveBtn("post_purchase").click();
    await page.getByText(/must point at this site/).waitFor({ timeout: 15_000 });
    const { rows } = await q("select cta_path from email_automations where key='post_purchase'");
    assert(rows[0].cta_path === "", `an off-site path was stored: ${rows[0].cta_path}`);
    return "refused and not stored";
  });

  await step("a full same-origin URL is accepted and folded to a path", async () => {
    await pathBox("post_purchase").fill(`${BASE}/products?reorder=1`);
    await saveAutomation("post_purchase");
    const { rows } = await q("select cta_path from email_automations where key='post_purchase'");
    assert(rows[0].cta_path === "/products?reorder=1", `stored ${JSON.stringify(rows[0].cta_path)}`);
    assert((await pathBox("post_purchase").inputValue()) === "/products?reorder=1", "form did not adopt the stored value");
    return "→ /products?reorder=1";
  });

  // --- click tracking ------------------------------------------------------
  section("9. Click tracking records the click and lands correctly");
  await step("a signed tracked link redirects to the automation's destination", async () => {
    await q("delete from email_automation_clicks where email = $1", ["qa-click@example.test"]);
    await q("delete from email_send_log where campaign_type = $1", ["automation:winback_60"]);
    await q(
      `insert into email_send_log (campaign_type, reference_id, recipient_email, template_key, sent_at, status)
       values ($1, $2, $3, $4, now(), 'sent')`,
      ["automation:winback_60", "qa-click@example.test:1700000000000", "qa-click@example.test", "automation_winback_60"],
    );

    // Sign the link the same way the sweep does. This is the ONE place the test
    // reproduces production logic rather than reading it, so it is kept to the
    // exact string automation-links.ts signs.
    const { createHmac } = await import("node:crypto");
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "local-shim-not-a-real-key";
    const reference = "qa-click@example.test:1700000000000";
    const token = createHmac("sha256", secret)
      .update(`automation:winback_60:qa-click@example.test:${reference}`)
      .digest("hex").slice(0, 32);

    const url = `${BASE}/api/email/automation-click?k=winback_60&e=${encodeURIComponent("qa-click@example.test")}&r=${encodeURIComponent(reference)}&t=${token}`;
    const clicker = await context.newPage();
    await clicker.goto(url, { waitUntil: "domcontentloaded" });
    const landed = clicker.url();
    await clicker.close();
    assert(landed.includes("/products"), `landed on ${landed}`);
    assert(landed.includes("ghkcu=1"), `landed on ${landed}, expected the winback_60 destination`);
    return landed;
  });

  await step("the click is recorded against the right automation and send", async () => {
    const { rows } = await q(
      "select automation_key, reference_id, email from email_automation_clicks where email = $1",
      ["qa-click@example.test"],
    );
    assert(rows.length === 1, `expected 1 click row, found ${rows.length}`);
    assert(rows[0].automation_key === "winback_60", `recorded against ${rows[0].automation_key}`);
    assert(rows[0].reference_id === "qa-click@example.test:1700000000000", `reference ${rows[0].reference_id}`);
    return `1 row, winback_60`;
  });

  await step("NO OTHER automation is credited with that click", async () => {
    // THE POINT OF THE WHOLE TRACKING CHANGE, stated as an assertion.
    //
    // The value of per-automation attribution is knowing WHICH sequence earned
    // the click. A scheme that recorded it against the wrong key — or against
    // all of them — would look identical in the admin to one that worked, and
    // the operator would scale the wrong email.
    //
    // The same address is mailed by all four sequences here, which is the case
    // most likely to smear attribution: a dormant customer really can be in the
    // win-back and the post-purchase sequence at once.
    const reference = "qa-click@example.test:1700000000000";
    for (const key of ["welcome_no_purchase", "post_purchase", "winback_30"]) {
      await q(
        `insert into email_send_log (campaign_type, reference_id, recipient_email, template_key, sent_at, status)
         values ($1, $2, $3, $4, now(), 'sent')
         on conflict do nothing`,
        [`automation:${key}`, reference, "qa-click@example.test", `automation_${key}`],
      );
    }

    const { rows: clicks } = await q(
      "select automation_key, count(*)::int as n from email_automation_clicks where email = $1 group by automation_key",
      ["qa-click@example.test"],
    );
    const byKey = Object.fromEntries(clicks.map((r) => [r.automation_key, r.n]));
    assert(byKey.winback_60 === 1, `winback_60 has ${byKey.winback_60 ?? 0} clicks, expected 1`);
    for (const key of ["welcome_no_purchase", "post_purchase", "winback_30"]) {
      assert(!byKey[key], `${key} was credited with ${byKey[key]} click(s) it did not earn`);
    }

    // And the per-send first-touch stamp is equally exclusive: three sequences
    // mailed this person, one was clicked, and only that one's row is marked.
    const { rows: stamped } = await q(
      "select campaign_type, clicked_at from email_send_log where recipient_email = $1 and campaign_type like 'automation:%'",
      ["qa-click@example.test"],
    );
    const clickedKeys = stamped.filter((r) => r.clicked_at).map((r) => r.campaign_type);
    assert(clickedKeys.length === 1 && clickedKeys[0] === "automation:winback_60",
      `clicked_at is set on ${JSON.stringify(clickedKeys)}`);
    return `winback_60: 1 · other three: 0, across ${stamped.length} sends to one address`;
  });

  await step("a link for one automation cannot be replayed against another", async () => {
    // Swapping the key in the URL while keeping the signature. The key is
    // inside the signed payload, so this must verify as nothing at all — not
    // as a click for the substituted automation.
    const { createHmac } = await import("node:crypto");
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "local-shim-not-a-real-key";
    const reference = "qa-click@example.test:1700000000000";
    const winback60Token = createHmac("sha256", secret)
      .update(`automation:winback_60:qa-click@example.test:${reference}`)
      .digest("hex").slice(0, 32);

    const before = (await q("select count(*)::int as n from email_automation_clicks where automation_key = $1", ["winback_30"])).rows[0].n;
    const url = `${BASE}/api/email/automation-click?k=winback_30&e=${encodeURIComponent("qa-click@example.test")}&r=${encodeURIComponent(reference)}&t=${winback60Token}`;
    const clicker = await context.newPage();
    await clicker.goto(url, { waitUntil: "domcontentloaded" });
    await clicker.close();
    const after = (await q("select count(*)::int as n from email_automation_clicks where automation_key = $1", ["winback_30"])).rows[0].n;
    assert(after === before, `winback_30 gained ${after - before} click(s) from a winback_60 signature`);
    return "signature is bound to its own automation";
  });

  await step("the send-log row is first-touch stamped for unique clicks", async () => {
    const { rows } = await q(
      "select clicked_at from email_send_log where campaign_type='automation:winback_60' and reference_id=$1",
      ["qa-click@example.test:1700000000000"],
    );
    assert(rows.length === 1 && rows[0].clicked_at, "clicked_at was not stamped");
    return `clicked_at ${new Date(rows[0].clicked_at).toISOString()}`;
  });

  await step("a tampered signature records nothing and still lands somewhere sane", async () => {
    const url = `${BASE}/api/email/automation-click?k=winback_60&e=${encodeURIComponent("attacker@example.test")}&r=x&t=${"0".repeat(32)}`;
    const clicker = await context.newPage();
    await clicker.goto(url, { waitUntil: "domcontentloaded" });
    const landed = clicker.url();
    await clicker.close();
    const { rows } = await q("select count(*)::int as n from email_automation_clicks where email=$1", ["attacker@example.test"]);
    assert(rows[0].n === 0, "an unsigned click was recorded");
    assert(landed.includes("/products"), `landed on ${landed}`);
    return "no row written, redirected to /products";
  });

  await step("the open pixel stamps opened_at", async () => {
    const { createHmac } = await import("node:crypto");
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "local-shim-not-a-real-key";
    const reference = "qa-click@example.test:1700000000000";
    const token = createHmac("sha256", secret)
      .update(`automation:winback_60:qa-click@example.test:${reference}`)
      .digest("hex").slice(0, 32);
    const res = await page.request.get(
      `${BASE}/api/email/automation-open?k=winback_60&e=${encodeURIComponent("qa-click@example.test")}&r=${encodeURIComponent(reference)}&t=${token}`,
    );
    assert(res.status() === 200, `pixel returned ${res.status()}`);
    assert(res.headers()["content-type"] === "image/gif", `pixel content-type ${res.headers()["content-type"]}`);
    const { rows } = await q(
      "select opened_at from email_send_log where campaign_type='automation:winback_60' and reference_id=$1",
      [reference],
    );
    assert(rows[0]?.opened_at, "opened_at was not stamped");
    return "pixel served, opened_at set";
  });

  // --- the stats surface ---------------------------------------------------
  section("10. The stats strip reflects what happened");
  await step("the admin shows the recorded click", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Automated sequences" }).waitFor();
    const strip = page.locator(`[data-testid="automation-winback_60-stats"]`);
    await strip.scrollIntoViewIfNeeded();
    const text = (await strip.innerText()).replace(/\s+/g, " ");
    assert(/CLICKS 1/i.test(text), `stats read: ${text}`);
    assert(/UNIQUE 1/i.test(text), `stats read: ${text}`);
    assert(/OPENED 1/i.test(text), `stats read: ${text}`);
    await page.screenshot({ path: `${SHOTS}/admin-stats.png` });
    return text;
  });

  // --- nothing else broke --------------------------------------------------
  section("11. The button markup is email-client-safe");
  await step("the rendered button leans on nothing a mail client strips", async () => {
    // A browser renders anything. Gmail strips <style> blocks in some contexts,
    // Outlook ignores most positioning, and no client guarantees CSS custom
    // properties. Every one of these would look perfect in the Playwright
    // screenshot above and break in a real inbox, which is exactly why the
    // screenshot is not the test.
    const { body } = await postAsPage(page, "/api/admin/email/automations/preview", {
      key: "winback_30", subject: "QA", headline: "QA headline",
      body: "Body copy.", ctaLabel: "SEE WHAT'S NEW", ctaPath: "/products?new=1",
    });
    assert(body?.success, `preview failed: ${JSON.stringify(body?.error ?? body)}`);
    const html = body.html;

    // Isolate the button so a banned token elsewhere in the shell cannot mask
    // or manufacture a failure.
    const start = html.indexOf('<table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center"');
    assert(start >= 0, "the button table is not in the rendered email");
    const button = html.slice(start, html.indexOf("</table>", start) + 8);

    const BANNED = [
      ["display:flex", "flexbox"],
      ["display:grid", "grid"],
      ["position:", "positioning"],
      ["var(--", "CSS custom properties"],
      // Matched with a boundary, not as a substring: `text-transform` is a
      // different property, is supported everywhere including Outlook, and is
      // what makes the label uppercase. Catching it here would be a false
      // positive that pushed the fix in the wrong direction.
      [/[;"\s]transform:/, "transforms"],
      ["box-shadow", "box-shadow"],
      ["!important", "!important"],
      ["@media", "media queries"],
      ["class=", "a class hook with no stylesheet to match it"],
      ["<style", "an embedded stylesheet"],
      ["rem", "root-relative units"],
    ];
    for (const [token, why] of BANNED) {
      const present = token instanceof RegExp ? token.test(button) : button.includes(token);
      assert(!present, `the button depends on ${why}: ${token}`);
    }

    // And the things it MUST have, which are what make it work where CSS does not.
    assert(/<table role="presentation"/.test(button), "the button is not table-based");
    assert(/<td[^>]*bgcolor="#/.test(button), "the fill is not on a bgcolor attribute");
    assert(button.includes("mso-padding-alt"), "no Word-specific padding");
    assert(button.includes("mso-line-height-rule:exactly"), "the line box is not pinned for Word");
    assert(/font-family:[^;]*Arial/.test(button), "no websafe font fallback");
    assert(!/font-size:\s*\d+(\.\d+)?(em|%)/.test(button), "font-size is not in absolute units");
    return "table + bgcolor + mso, no browser-only CSS";
  });

  section("12. The shared CTA change did not break other mail");
  await step("a customer campaign can still be composed and saved", async () => {
    // The composer is the other writer of cta_label/cta_path and shares the
    // validator the automations route uses, so a change there could break it
    // silently. This drives the real form rather than the API.
    await page.locator('[data-testid="field-campaign-name"]').fill("QA shared-CTA check");
    await page.locator('[data-testid="field-subject"]').fill("QA subject line");
    await page.locator('[data-testid="field-headline"]').fill("QA headline");
    await page.locator('[data-testid="field-body"]').fill("Body copy for the QA campaign.");
    await page.locator('[data-testid="field-cta-label"]').fill("SHOP NOW");
    await page.locator('[data-testid="field-cta-path"]').fill("/products");
    await page.getByRole("button", { name: "Save draft" }).click();
    await page.waitForTimeout(2500);
    const { rows } = await q("select name, cta_label, cta_path from email_campaigns where name = $1", ["QA shared-CTA check"]);
    assert(rows.length === 1, `expected 1 campaign row, found ${rows.length}`);
    assert(rows[0].cta_label === "SHOP NOW", `campaign stored label ${JSON.stringify(rows[0].cta_label)}`);
    assert(rows[0].cta_path === "/products", `campaign stored path ${JSON.stringify(rows[0].cta_path)}`);
    return `${rows[0].cta_label} → ${rows[0].cta_path}`;
  });

  await step("an affiliate broadcast still renders its button", async () => {
    const { body } = await postAsPage(page, "/api/admin/affiliates/campaigns/preview", {
      name: "QA", subject: "QA subject", previewText: "QA", headline: "QA headline",
      body: "Hello there.", ctaLabel: "SHOP NOW", ctaPath: "/products", linkButtons: [],
      affiliateFilter: "all_active",
    });
    assert(body?.success, `affiliate preview failed: ${JSON.stringify(body?.error ?? body).slice(0, 200)}`);
    assert(body.html.includes("border-radius:999px"), "campaign CTA lost its button styling");
    assert(body.html.includes("mso-padding-alt"), "campaign CTA is not Outlook-safe");
    writeFileSync(`${SHOTS}/email-campaign.html`, body.html);
    return "campaign button intact";
  });

  await step("a real transactional email still renders, and stays neutral", async () => {
    // Not a rendered fixture — an ACTUAL order placed through checkout, whose
    // confirmation is read back out of the capture file the noop provider
    // writes (providers/noop.ts, EMAIL_CAPTURE_DIR). That is the same message
    // a customer would receive.
    //
    // The assertion that matters is the LAST one. The brief was explicit that
    // transactional mail must not become sales mail, and the failure mode is
    // silent: a receipt that quietly turns gold looks fine in isolation and is
    // only wrong next to the marketing it now resembles.
    const { existsSync, readFileSync, statSync } = await import("node:fs");
    const CAPTURE = "/tmp/vanta-qa/captured-emails.jsonl";
    const before = existsSync(CAPTURE) ? statSync(CAPTURE).size : 0;

    await q("delete from rate_limit_hits").catch(() => {});
    const buyer = `qa-txn-${Date.now()}@example.test`;
    const shop = await context.newPage();
    await shop.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });
    const created = await shop.evaluate(async ([payload]) => {
      const res = await fetch("/api/checkout/create-session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "same-origin", body: JSON.stringify(payload),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }, [{
      items: [{ id: "bpc-157-10mg", quantity: 1 }],
      customer: {
        email: buyer, fullName: "Txn Tester", address: "1 Harness Way",
        city: "Testville", state: "CA", postalCode: "90000", country: "US", phone: "5555555555",
      },
      currency: "USD",
      complianceAcknowledgements: { researchCompliance: true, returnsPolicy: true },
    }]);
    await shop.close();
    assert(created.body?.orderId, `checkout failed: ${JSON.stringify(created.body).slice(0, 200)}`);

    // Drive it to paid through the real webhook handler, which is what sends
    // the confirmation.
    const { execFileSync } = await import("node:child_process");
    execFileSync("node", ["scripts/harness-pay-order.mjs", created.body.orderId], {
      env: { ...process.env, PAYMENT_WEBHOOK_SECRET: "harness-webhook-secret" },
      stdio: "pipe",
    });

    const raw = existsSync(CAPTURE) ? readFileSync(CAPTURE) : Buffer.alloc(0);
    const fresh = raw.subarray(Math.min(before, raw.length)).toString("utf8")
      .split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    const confirmation = fresh.find((m) => /order confirmed/i.test(m.subject ?? ""));
    assert(confirmation, `no order confirmation captured; got ${JSON.stringify(fresh.map((m) => m.subject))}`);

    const html = confirmation.html;
    assert(html.includes("background:#050505"), "the confirmation lost the branded shell");
    assert(html.includes("order-confirmation/"), "the new View order CTA is missing");
    assert(html.includes("border-radius:999px"), "the CTA is not a styled button");
    assert(html.includes("mso-padding-alt"), "the transactional CTA is not Outlook-safe");
    assert(html.includes('bgcolor="#F4F4F4"'), "the transactional CTA is not the neutral variant");
    assert(!html.includes("#F2C94C"), "a RECEIPT was rendered in marketing gold");
    // Transactional mail must not carry marketing's unsubscribe furniture.
    assert(!/List-Unsubscribe/i.test(JSON.stringify(confirmation.headers ?? {})),
      "a receipt carried List-Unsubscribe headers");
    writeFileSync(`${SHOTS}/email-transactional.html`, html);
    transactionalOrderId = created.body.orderId;
    return `${confirmation.subject} — neutral button, Outlook-safe, no unsubscribe header`;
  });

  await step("an order after the click is attributed to that automation", async () => {
    // The last link in the chain the brief asks for: sends, clicks, and then
    // ORDERS and REVENUE per automation. This order was placed in the same
    // browser context that clicked the winback_60 link in section 9 — which is
    // exactly what a customer does — so the attribution cookie the click route
    // set is what stamps it.
    //
    // Checked on the column rather than on the admin strip, because the strip
    // reads this column: asserting on the strip alone would pass if both were
    // wrong in the same direction.
    assert(transactionalOrderId, "no order id captured from the transactional step");
    const { rows } = await q(
      "select attributed_automation_key, attributed_automation_at, attributed_campaign_id from orders where order_id = $1",
      [transactionalOrderId],
    );
    assert(rows[0]?.attributed_automation_key === "winback_60",
      `attributed to ${rows[0]?.attributed_automation_key ?? "nothing"}`);
    assert(rows[0].attributed_automation_at, "stamped with no timestamp");
    // And the campaign column is untouched, because this was not a campaign.
    // The two attributions are separate slots by design.
    assert(!rows[0].attributed_campaign_id, "an automation click wrote the campaign column");
    return "winback_60, campaign column untouched";
  });

  await step("no console errors and no failed requests", async () => {
    // This run deliberately drives three REFUSALS — an unsigned click, an
    // off-site destination, and a half-filled CTA — and each one is a 4xx the
    // browser logs to the console. They are passing assertions, not failures,
    // so they are named rather than globally ignored.
    // Two groups are expected, and neither is a regression.
    //
    // OURS, DELIBERATE: this run drives three refusals — an unsigned click, an
    // off-site destination and a half-filled CTA — and each one is a 4xx the
    // browser logs. They are the passing assertions.
    //
    // PRE-EXISTING HARNESS GAPS: verified by loading a plain product page in a
    // clean browser with none of this work involved, which produces the
    // identical set. /api/catalog/bac-water 404s because the harness seed has
    // four products and no bac-water accessory while the upsell component
    // fetches it on every product page; /api/account/me and
    // /api/admin/auth/session 401 for a logged-out visitor, which is the
    // correct answer to "who is this"; _next/image 400s on the synthetic seed
    // images. Naming them beats a blanket ignore that would also hide a real one.
    const EXPECTED = new RegExp([
      "automation-click",
      "/api/admin/email/automations($|\\?)",
      "/api/catalog/bac-water",
      "/api/account/me",
      "/api/admin/auth/session",
      "/_next/image",
    ].join("|"));
    const unexpected = httpProblems.filter((p) => !EXPECTED.test(p));
    console.log(`        ${httpProblems.length} 4xx seen, ${unexpected.length} unexpected`);
    for (const u of unexpected.slice(0, 10)) console.log(`          ${u}`);
    assert(unexpected.length === 0, `unexpected HTTP failures: ${unexpected.slice(0, 3).join(" | ")}`);
    return `clean — ${httpProblems.length} expected 4xx from the refusal tests`;
  });

  await browser.close();
}

main()
  .catch((error) => {
    console.error("\nHARNESS ERROR:", error);
    results.push({ section: section_, name: "harness", status: "fail", detail: String(error?.message ?? error) });
  })
  .finally(async () => {
    await pool.end().catch(() => {});
    const pass = results.filter((r) => r.status === "pass").length;
    const fail = results.filter((r) => r.status === "fail").length;
    console.log(`\n${"=".repeat(60)}\n  ${pass} passed, ${fail} failed`);
    if (fail) {
      console.log("\nFAILURES:");
      for (const r of results.filter((x) => x.status === "fail")) console.log(`  - [${r.section}] ${r.name}: ${r.detail}`);
    }
    console.log(`  screenshots: ${SHOTS}`);
    process.exit(fail ? 1 : 0);
  });
