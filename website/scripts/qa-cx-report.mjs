#!/usr/bin/env node
// Turns a matrix run into the two tables the certification asks for, so the
// numbers in the report are the numbers that ran rather than a transcription.
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

const OUT = process.env.CX_OUT_DIR ?? "/tmp/cx-matrix";
const results = JSON.parse(readFileSync(`${OUT}/results.json`, "utf8"));
const client = new pg.Client({ connectionString: process.env.CX_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront" });
await client.connect();
const { rows: products } = await client.query(
  `select p.slug, p.name, count(d.id)::int doses
   from products p left join product_doses d on d.product_id = p.id
   where p.is_active and p.is_published and p.is_enabled and not p.is_archived
   group by p.slug, p.name order by p.slug`);
await client.end();

const has = (pred) => results.filter(pred);
const verdictOf = (rs) => rs.length === 0 ? "—" : rs.every((r) => r.verdict === "PASS") ? "PASS" : "FAIL";

const rows = products.map((p) => {
  const pdp = has((r) => r.group === "pdp" && (r.entry ?? "").includes(`/products/${p.slug}`));
  const variants = has((r) => r.group === "variants" && (r.entry ?? "").includes(`/products/${p.slug}`));
  // "cart-all" IS THE GROUP THAT COVERS EVERY PRODUCT, AND IT WAS LEFT OUT.
  // Without it this reported CART COVERAGE 10/34 while the run had in fact put
  // all 34 through a basket — understating the very number the brief asks for.
  // An out-of-stock product's cart scenario asserts that it is REFUSED, which
  // is coverage of the cart decision, not an absence of it.
  const cart = has((r) => ["cart", "cart-all", "variants", "checkout", "nowheel", "in-app", "security"].includes(r.group)
    && ((r.entry ?? "") + (r.actual ?? "")).includes(p.slug));
  const mobile = has((r) => ["mobile", "in-app"].includes(r.group) && ((r.entry ?? "") + (r.actual ?? "")).includes(p.slug));
  return { ...p, pdp: verdictOf(pdp), pdpN: pdp.length, variants: verdictOf(variants), variantsN: variants.length,
           cart: verdictOf(cart), cartN: cart.length, mobile: verdictOf(mobile) };
});

const counts = {
  total: results.length,
  pass: results.filter((r) => r.verdict === "PASS").length,
  fail: results.filter((r) => r.verdict === "FAIL").length,
  na: results.filter((r) => r.verdict === "NOT SAFELY TESTABLE").length,
};
const pdpCovered = rows.filter((r) => r.pdpN > 0).length;
const cartCovered = rows.filter((r) => r.cartN > 0).length;

const byGroup = {};
for (const r of results) {
  byGroup[r.group] ??= { pass: 0, fail: 0 };
  byGroup[r.group][r.verdict === "PASS" ? "pass" : "fail"] += 1;
}

const md = [
  `TOTAL SCENARIOS EXECUTED: ${counts.total}`,
  `PASS: ${counts.pass}`,
  `FAIL: ${counts.fail}`,
  `NOT SAFELY TESTABLE: ${counts.na}`,
  ``,
  `TOTAL LIVE PRODUCTS: ${products.length}`,
  `PDP COVERAGE: ${pdpCovered}/${products.length}`,
  `CART COVERAGE: ${cartCovered}/${products.length}`,
  ``,
  `| Group | Pass | Fail |`, `|---|---|---|`,
  ...Object.entries(byGroup).sort().map(([g, v]) => `| ${g} | ${v.pass} | ${v.fail} |`),
  ``,
  `| Product | Doses | PDP | Variants | Cart | Mobile |`,
  `|---|---|---|---|---|---|`,
  ...rows.map((r) => `| ${r.name} (\`${r.slug}\`) | ${r.doses} | ${r.pdp} | ${r.variants === "—" ? "n/a" : r.variants} | ${r.cart} | ${r.mobile === "—" ? "via sweep" : r.mobile} |`),
].join("\n");

writeFileSync(`${OUT}/coverage.md`, md);
console.log(md);
