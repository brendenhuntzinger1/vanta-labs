// Renders card.html -> print-ready PDF + 300 DPI PNG previews.
// Usage: node build.mjs   (expects card.html next to this file; see README.md)
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

// Resolve playwright from the local project if installed, else the global lib.
const require = createRequire(import.meta.url);
const { chromium } = (() => {
  for (const spec of [
    "playwright-core",
    "playwright",
    "/opt/node22/lib/node_modules/playwright",
  ]) {
    try {
      return require(spec);
    } catch {}
  }
  throw new Error("playwright not found — npm i -D playwright-core");
})();

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(dir, "out");
fs.mkdirSync(outDir, { recursive: true });

const executablePath =
  process.env.CARD_CHROMIUM ||
  ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium"].find(fs.existsSync);

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({
  viewport: { width: 360, height: 432 }, // 3.75in x (2 x 2.25in) at 96 CSS px/in
  deviceScaleFactor: 3.125, // 300 DPI
});
await page.goto("file://" + path.join(dir, "card.html"));
await page.evaluate(() => document.fonts.ready);

// Print-ready PDF (both sides, page size = bleed size 3.75in x 2.25in)
await page.pdf({
  path: path.join(outDir, "vanta-labs-business-card-print.pdf"),
  printBackground: true,
  preferCSSPageSize: true,
});

// 300 DPI raster previews, one per side
const pages = await page.locator(".page").all();
await pages[0].screenshot({ path: path.join(outDir, "preview-front.png") });
await pages[1].screenshot({ path: path.join(outDir, "preview-back.png") });

await browser.close();
console.log("wrote", fs.readdirSync(outDir).join(", "), "to", outDir);
