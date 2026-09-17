#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE PRIZE CATALOGUE, IN THE HARNESS.
//
// WHY THIS EXISTS. The local harness ships a small demo catalogue —
// bpc-157-10mg, tb-500-5mg, ipamorelin-5mg, cjc-1295-2mg, recon-water — and
// NONE of the wheel's twelve prize slugs are in it. That is not a cosmetic
// gap: quoteOrder resolves a gift with an exact `candidate.slug ===
// offer.product_slug` and has no fallback, so on the harness every product
// prize silently resolves to nothing.
//
// The failure mode that makes this worth a file: a redemption test run against
// the stock harness PASSES its "no gift below the minimum" assertion and
// SKIPS its "gift added above the minimum" one, because there is no gift
// either way. It reads as a green run of a test that never exercised the
// thing it names. That is how a wheel could be mailed to a live list having
// been "verified" against a catalogue that cannot award any of its prizes.
//
// So this mirrors the twelve real products and their doses, copied from
// production's own rows (shape and stock, not secrets), into the harness.
// Idempotent: re-running updates in place.
//
//   node scripts/seed-prize-catalogue.mjs
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
if (!/localhost|127\.0\.0\.1/.test(DB)) {
  console.error("Refusing to seed anything but the local harness.");
  process.exit(1);
}

// Copied from production on 2026-09-17. Prices in cents, stock as it stood.
const CATALOGUE = [
  { slug: "recon-water", name: "Recon water (0.9% Benzyl Alcohol)", category: "Solvents & Solutions", price_cents: 1499, product_cost_cents: 800, track_inventory: false, image_url: "", doses: [{ label: "10mL", price_cents: 1499, inventory_quantity: 54, track_inventory: false, is_default: true, position: 0, product_cost_cents: 143, slug_suffix: "10ml" }] },
  { slug: "ghk-cu", name: "GHK-Cu", category: "Repair & Recovery Research", price_cents: 3999, product_cost_cents: 2288, track_inventory: false, image_url: "https://example.invalid/ghk-cu.webp", doses: [{ label: "50mg", price_cents: 3999, inventory_quantity: 40, track_inventory: true, is_default: true, position: 1, product_cost_cents: 365, slug_suffix: "50mg" }] },
  { slug: "glp-1", name: "GLP-1", category: "GLP Research", price_cents: 4499, product_cost_cents: 2456, track_inventory: false, image_url: "https://example.invalid/glp-1.webp", doses: [
    { label: "5mg", price_cents: 4499, inventory_quantity: 29, track_inventory: true, is_default: true, position: 0, product_cost_cents: 383, slug_suffix: "5mg" },
    { label: "10mg", price_cents: 6499, inventory_quantity: 29, track_inventory: true, is_default: false, position: 1, product_cost_cents: 484, slug_suffix: "10mg" }] },
  { slug: "klow", name: "KLOW", category: "Blends", price_cents: 11999, product_cost_cents: 3500, track_inventory: true, image_url: "https://example.invalid/klow.webp", doses: [{ label: "80mg", price_cents: 11999, inventory_quantity: 18, track_inventory: true, is_default: true, position: 0, product_cost_cents: 2507, slug_suffix: "80mg" }] },
  { slug: "semax", name: "Semax", category: "Cognitive Research", price_cents: 4999, product_cost_cents: 3039, track_inventory: true, image_url: "https://example.invalid/semax.webp", doses: [{ label: "10mg", price_cents: 4999, inventory_quantity: 19, track_inventory: true, is_default: true, position: 0, product_cost_cents: 586, slug_suffix: "10mg" }] },
  { slug: "mt-2-melanotan-ii", name: "MT-2", category: "Specialty", price_cents: 3999, product_cost_cents: 2783, track_inventory: true, image_url: "https://example.invalid/mt-2.webp", doses: [{ label: "10mg", price_cents: 3999, inventory_quantity: 17, track_inventory: true, is_default: true, position: 0, product_cost_cents: 530, slug_suffix: "10mg" }] },
  { slug: "glow", name: "GLOW", category: "Blends", price_cents: 10999, product_cost_cents: 3500, track_inventory: false, image_url: "https://example.invalid/glow.webp", doses: [{ label: "70mg", price_cents: 10999, inventory_quantity: 19, track_inventory: true, is_default: true, position: 1, product_cost_cents: 2154, slug_suffix: "70mg" }] },
  { slug: "glp-2", name: "GLP-2", category: "GLP Research", price_cents: 4999, product_cost_cents: 2376, track_inventory: true, image_url: "", doses: [{ label: "5mg", price_cents: 4999, inventory_quantity: 29, track_inventory: true, is_default: true, position: 0, product_cost_cents: 438, slug_suffix: "5mg" }] },
  { slug: "cjc-1295-ipamorelin", name: "CJC-1295 + Ipamorelin", category: "Growth Hormone", price_cents: 6999, product_cost_cents: 2914, track_inventory: true, image_url: "https://example.invalid/cjc.webp", doses: [{ label: "10mg", price_cents: 6999, inventory_quantity: 16, track_inventory: true, is_default: true, position: 0, product_cost_cents: 1112, slug_suffix: "10mg" }] },
  // Five units in production. Kept at five here on purpose: this is the one
  // prize a real campaign can exhaust, and a harness that pretends otherwise
  // would never show it.
  { slug: "tesamorelin", name: "Tesamorelin", category: "Growth Hormone", price_cents: 7499, product_cost_cents: 3414, track_inventory: false, image_url: "https://example.invalid/tesa.webp", doses: [{ label: "10mg", price_cents: 7499, inventory_quantity: 5, track_inventory: true, is_default: true, position: 1, product_cost_cents: 2033, slug_suffix: "10mg" }] },
  { slug: "glp-3", name: "GLP-3", category: "GLP Research", price_cents: 4999, product_cost_cents: 2306, track_inventory: true, image_url: "", doses: [
    { label: "5mg", price_cents: 4999, inventory_quantity: 29, track_inventory: true, is_default: true, position: 0, product_cost_cents: 632, slug_suffix: "5mg" },
    { label: "10mg", price_cents: 6999, inventory_quantity: 36, track_inventory: true, is_default: false, position: 1, product_cost_cents: 1047, slug_suffix: "10mg" }] },
  { slug: "hgh-gh-191", name: "HGH GH-191", category: "Growth Hormone", price_cents: 6499, product_cost_cents: 2804, track_inventory: true, image_url: "https://example.invalid/hgh.webp", doses: [
    { label: "24iu", price_cents: 6499, inventory_quantity: 20, track_inventory: true, is_default: true, position: 0, product_cost_cents: 1200, slug_suffix: "24iu" },
    { label: "36iu", price_cents: 8499, inventory_quantity: 18, track_inventory: true, is_default: false, position: 1, product_cost_cents: 1634, slug_suffix: "36iu" }] },
];

const pool = new pg.Pool({ connectionString: DB });
const q = (t, p) => pool.query(t, p);

const main = async () => {
  let products = 0;
  let doses = 0;
  for (const p of CATALOGUE) {
    const { rows } = await q(`select id from products where slug = $1`, [p.slug]);
    const id = rows[0]?.id ?? randomUUID();
    if (rows[0]) {
      await q(
        `update products set name=$2, category=$3, price_cents=$4, product_cost_cents=$5,
           track_inventory=$6, image_url=$7, stock_status='In Stock',
           is_active=true, is_enabled=true, is_published=true, is_archived=false, updated_at=now()
         where id=$1`,
        [id, p.name, p.category, p.price_cents, p.product_cost_cents, p.track_inventory, p.image_url]);
    } else {
      await q(
        `insert into products (id, slug, name, category, price_cents, product_cost_cents,
           inventory_quantity, track_inventory, stock_status, image_url,
           is_active, is_enabled, is_published, is_archived, requires_reconstitution,
           shipping_weight_oz, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,0,$7,'In Stock',$8,true,true,true,false,false,0.36, now(), now())`,
        [id, p.slug, p.name, p.category, p.price_cents, p.product_cost_cents, p.track_inventory, p.image_url]);
    }
    products += 1;

    for (const d of p.doses) {
      const { rows: dr } = await q(`select id from product_doses where product_id=$1 and label=$2`, [id, d.label]);
      if (dr[0]) {
        await q(
          `update product_doses set price_cents=$2, inventory_quantity=$3, track_inventory=$4,
             stock_status='In Stock', is_default=$5, is_enabled=true, position=$6,
             product_cost_cents=$7, slug_suffix=$8, updated_at=now() where id=$1`,
          [dr[0].id, d.price_cents, d.inventory_quantity, d.track_inventory, d.is_default, d.position, d.product_cost_cents, d.slug_suffix]);
      } else {
        await q(
          `insert into product_doses (id, product_id, label, slug_suffix, price_cents, inventory_quantity,
             track_inventory, stock_status, is_default, is_enabled, position, product_cost_cents,
             reserved_quantity, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,'In Stock',$8,true,$9,$10,0, now(), now())`,
          [randomUUID(), id, d.label, d.slug_suffix, d.price_cents, d.inventory_quantity,
           d.track_inventory, d.is_default, d.position, d.product_cost_cents]);
      }
      doses += 1;
    }
  }
  console.log(`seeded ${products} prize products, ${doses} doses`);
  await pool.end();
};

main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
