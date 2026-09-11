#!/usr/bin/env node
/**
 * Render a creative or an email from this kit with headless Chromium.
 *
 *   node render.mjs creative <canvas.html> <out.png>
 *       Screenshots the canvas at 1040px wide (the canvas sets html{zoom:2}
 *       on a 520px layout, so the PNG is 2x for phones). Height comes from
 *       the canvas's own .c element.
 *
 *   node render.mjs email <email.html> <out-prefix>
 *       Writes <out-prefix>-390.png and <out-prefix>-640.png, full page.
 *
 * Uses the Playwright in website/node_modules and the Chromium the cloud
 * container pre-installs. Serves the file's directory over HTTP for the
 * duration of the run, because the Playwright MCP blocks file:// and
 * Google Fonts will not load from a file:// origin either.
 */
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const require = createRequire(path.join(repoRoot, "website", "package.json"));
const { chromium } = require("playwright");

const [mode, input, output] = process.argv.slice(2);
if (!mode || !input || !output) {
  console.error("usage: render.mjs creative <canvas.html> <out.png> | email <email.html> <out-prefix>");
  process.exit(2);
}

const file = path.resolve(input);
const root = path.dirname(file);
const types = { ".html": "text/html", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".css": "text/css" };

const server = createServer(async (req, res) => {
  const target = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!target.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    await stat(target);
    res.writeHead(200, { "content-type": types[path.extname(target).toLowerCase()] ?? "application/octet-stream" });
    res.end(await readFile(target));
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/${path.basename(file)}`;

// The cloud container pre-installs one Chromium at /opt/pw-browsers/chromium.
// website/ may pin a newer Playwright whose own browser build is not
// downloaded, so prefer the pre-installed binary when it exists and fall back
// to whatever Playwright resolves on a developer machine.
const preinstalled = "/opt/pw-browsers/chromium";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? (existsSync(preinstalled) ? preinstalled : undefined);
// The cloud session reaches the internet only through an agent proxy that
// Chromium does not pick up from the environment on its own. Without this the
// Google Fonts link fails silently and every render falls back to Georgia.
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: process.env.NO_PROXY ?? "" } : undefined;
// `--ssl-version-max=tls1.2` is what the repo's Playwright MCP config uses
// (.playwright-mcp.json): the proxy relay resets TLS 1.3 handshakes from
// Chromium, which shows up as ERR_CONNECTION_RESET on every external request.
const args = ["--no-sandbox", "--ssl-version-max=tls1.2"];
const browser = await chromium.launch({ args, ...(executablePath ? { executablePath } : {}), ...(proxy ? { proxy } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1040, height: 1200 } });
  page.on("requestfailed", (r) => console.warn("failed to load", r.url()));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);

  if (mode === "creative") {
    const box = await page.locator(".c").first().boundingBox();
    if (!box) throw new Error("the canvas has no .c element");
    await page.setViewportSize({ width: Math.round(box.width), height: Math.round(box.height) });
    await page.screenshot({ path: output, clip: { x: 0, y: 0, width: Math.round(box.width), height: Math.round(box.height) } });
    console.log(`wrote ${output} (${Math.round(box.width)}x${Math.round(box.height)})`);
  } else if (mode === "email") {
    for (const width of [390, 640]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      const out = `${output}-${width}.png`;
      await page.screenshot({ path: out, fullPage: true });
      console.log(`wrote ${out}`);
    }
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} finally {
  await browser.close();
  server.close();
}
