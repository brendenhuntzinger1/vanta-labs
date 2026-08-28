#!/usr/bin/env node
/**
 * Cross-engine layout check.
 *
 * WHY THIS EXISTS: only Chromium is pre-installed here, and a spoofed iPhone
 * user-agent changes the string, not the engine. Every iOS in-app browser —
 * TikTok, Instagram, Facebook, Snapchat — is WKWebView, i.e. WebKit. So the
 * browsers this project most needs to be correct in are the ones Chromium
 * cannot speak for. This drives the real engines.
 *
 * READ-ONLY. It clears the age gate (sessionStorage only, the sole way to see
 * the site at all) and then measures. It never adds to a cart, never submits a
 * form, never touches checkout, an account or a coupon — so it is safe against
 * production, which is the only thing it should ever be pointed at without a
 * local harness running.
 *
 *   ENGINE=webkit node scripts/cross-engine-check.mjs
 *   ENGINE=firefox BASE_URL=https://www.vantalabsresearch.com node scripts/cross-engine-check.mjs
 *
 * PREREQUISITE: playwright-core is NOT a dependency of this app, deliberately —
 * nothing in the product imports it. Install it and the engines first; see
 * docs/BROWSER-TESTING-RUNBOOK.md, "Chromium is not Safari", which gives the
 * exact commands. Exits non-zero if any real layout defect is found.
 */
import * as pw from "playwright-core";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const ENGINE = process.env.ENGINE || "webkit";
const launcher = pw[ENGINE];
if (!launcher) {
  console.error(`unknown ENGINE "${ENGINE}" — use webkit, firefox or chromium`);
  process.exit(2);
}

// The egress proxy resets TLS 1.3. Each engine caps differently; WebKit copes
// unaided. Without these the pages look dead, which reads as a site-wide
// outage and is not one.
const LAUNCH = {
  chromium: {
    headless: true,
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--no-sandbox", "--ssl-version-max=tls1.2"],
  },
  firefox: { headless: true, firefoxUserPrefs: { "security.tls.version.max": 3 } },
  webkit: { headless: true },
}[ENGINE];

const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const CASES = [
  ["TikTok WebView", `${IOS} Mobile/15E148 musical_ly_2023005030 BytedanceWebview/d8a21c6`, { width: 393, height: 664 }],
  ["Instagram WebView", `${IOS} Mobile/21F90 Instagram 335.0.0.34.95 (iPhone16,1; iOS 17_5_1)`, { width: 393, height: 692 }],
  ["iPhone SE in TikTok", `${IOS} Mobile/15E148 musical_ly_2023005030 BytedanceWebview/d8a21c6`, { width: 375, height: 548 }],
  ["Safari iOS", `${IOS} Version/17.5 Mobile/15E148 Safari/604.1`, { width: 393, height: 659 }],
  ["tablet", null, { width: 768, height: 1024 }],
  ["laptop", null, { width: 1280, height: 800 }],
];
const ROUTES = ["/products", "/cart", "/research", "/contact", "/legal/privacy"];

const findings = [];

async function clearGate(page) {
  const boxes = page.locator('input[type="checkbox"]');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) await boxes.nth(i).check({ force: true, timeout: 5000 }).catch(() => {});
  const guest = page.getByRole("button", { name: /continue as guest/i }).first();
  await guest.scrollIntoViewIfNeeded().catch(() => {});
  return guest.click({ timeout: 9000 }).then(() => true).catch(() => false);
}

/** Layout facts only. Anything here reproduces across engines if it is real. */
const PROBE = () => {
  const de = document.documentElement;
  const vw = window.innerWidth;
  const offenders = [...document.querySelectorAll("body *")]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return false;
      return r.right > vw + 1;
    })
    .slice(0, 3)
    .map((el) => `${el.tagName.toLowerCase()}.${String(el.className || "").slice(0, 34)}(+${Math.round(el.getBoundingClientRect().right - vw)}px)`);
  // The staff shortcut must never sit over a customer CTA bar. z-index cannot
  // be trusted across stacking contexts, so this hit-tests rather than
  // comparing paint order. It probes, it does not tap.
  const bar = [...document.querySelectorAll(".vl-cta-bar")].find((e) => getComputedStyle(e).display !== "none");
  const cta = bar ? [...bar.querySelectorAll("button,a")].find((e) => e.getBoundingClientRect().width > 60) : null;
  let vaultStealsTap = null;
  if (cta) {
    const r = cta.getBoundingClientRect();
    const hit = document.elementFromPoint(r.right - 8, r.bottom - 6);
    vaultStealsTap = !!(hit && hit.closest('a[href="/vault"]'));
  }
  return {
    overflow: de.scrollWidth > vw + 1,
    overBy: de.scrollWidth - vw,
    offenders,
    textLen: (document.body.innerText || "").trim().length,
    vaultStealsTap,
  };
};

const browser = await launcher.launch(LAUNCH);
for (const [label, ua, viewport] of CASES) {
  const ctx = await browser.newContext({
    ...(ua ? { userAgent: ua } : {}),
    viewport,
    // Firefox does not support Playwright's mobile emulation.
    ...(viewport.width < 500 && ENGINE !== "firefox" ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await ctx.newPage();
  console.log(`\n### ${ENGINE} — ${label} ${viewport.width}x${viewport.height}`);
  try {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 70000 });
    await page.waitForTimeout(3000);
    if (!(await clearGate(page))) {
      console.log("  age gate could not be cleared");
      findings.push(`${ENGINE}/${label}: age gate not clearable`);
    }
    await page.waitForTimeout(3000);
    for (const route of ROUTES) {
      await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 70000 }).catch(() => {});
      await page.waitForTimeout(2500);
      const m = await page.evaluate(PROBE);
      const empty = m.textLen < 80;
      if (m.overflow) findings.push(`${ENGINE}/${label}${route}: overflow +${m.overBy}px — ${m.offenders.join(", ")}`);
      if (empty) findings.push(`${ENGINE}/${label}${route}: page rendered empty`);
      if (m.vaultStealsTap) findings.push(`${ENGINE}/${label}${route}: /vault shortcut is stealing the CTA tap`);
      console.log(
        `  ${route.padEnd(18)} overflow=${String(m.overflow).padEnd(5)}` +
          `${m.overflow ? ` +${m.overBy}px ${m.offenders.join(", ")}` : ""}` +
          ` text=${m.textLen}${m.vaultStealsTap === null ? "" : ` vaultStealsTap=${m.vaultStealsTap}`}`,
      );
    }
  } catch (e) {
    // A single-resource TLS failure or timeout that does not reproduce across
    // engines is the proxy, not the site. Reported, never silently swallowed.
    console.log(`  navigation failed: ${String(e).slice(0, 120)}`);
    findings.push(`${ENGINE}/${label}: navigation failed (check whether it reproduces — likely transport)`);
  }
  await ctx.close();
}
await browser.close();

console.log(`\n=== ${ENGINE}: ${findings.length} finding(s) ===`);
for (const f of findings) console.log("  - " + f);
process.exit(findings.length ? 1 : 0);
