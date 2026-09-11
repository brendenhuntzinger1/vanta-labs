#!/usr/bin/env node
/**
 * Download product photos for a campaign into products/<slug>.jpg.
 *
 *   node fetch-products.mjs products.json [outDir]
 *
 * products.json is an array of { slug, image_url } rows, normally the output
 * of the read-only catalogue query in references/data-findings.md. WebP is
 * converted to JPEG with the sharp that ships in website/node_modules, because
 * Outlook for Windows does not render WebP. Rows with an empty image_url are
 * reported and skipped; they render the placeholder tile in an email.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const require = createRequire(path.join(repoRoot, "website", "package.json"));
const sharp = require("sharp");

const [listFile, outDir = "products"] = process.argv.slice(2);
if (!listFile) { console.error("usage: fetch-products.mjs products.json [outDir]"); process.exit(2); }

const rows = JSON.parse(await readFile(listFile, "utf8"));
await mkdir(outDir, { recursive: true });

for (const row of rows) {
  const slug = String(row.slug ?? "").trim();
  const url = String(row.image_url ?? "").trim();
  if (!slug) continue;
  if (!url || !/^https:\/\//.test(url)) { console.warn(`${slug}: no photo, will render the placeholder tile`); continue; }
  const res = await fetch(url);
  if (!res.ok) { console.warn(`${slug}: ${res.status} from the bucket`); continue; }
  const bytes = Buffer.from(await res.arrayBuffer());
  const out = path.join(outDir, `${slug}.jpg`);
  await writeFile(out, await sharp(bytes).jpeg({ quality: 88 }).toBuffer());
  const meta = await sharp(out).metadata();
  console.log(`${slug}: ${meta.width}x${meta.height} -> ${out}`);
}
