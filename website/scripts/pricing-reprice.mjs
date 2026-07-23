// ============================================================================
// VANTA LABS — RECOMMENDED REPRICE
// For every product below a healthy merchandise-margin floor at BASE EVO cost,
// compute a psychologically-priced retail that clears the floor — EXCEPT the
// deliberate "loss-leader" entry doses of a multi-dose hero line (their bigger
// siblings carry the margin, and a cheap entry dose pulls buyers into the line).
// Emits a review table + ready-to-run UPDATE SQL (products + default dose).
// ============================================================================

// slug_suffix-level catalog: [productSlug, doseSuffix, cost, currentRetail]
const DOSES = [
  ["glp-1-semaglutide","5mg",24.56,42.99], ["glp-1-semaglutide","10mg",25.37,64.99],
  ["glp-1-semaglutide","20mg",26.90,109.99], ["glp-1-semaglutide","30mg",27.80,144.99],
  ["glp-2-tirzepatide","5mg",23.76,47.99], ["glp-2-tirzepatide","10mg",24.84,74.99],
  ["glp-2-tirzepatide","20mg",26.46,124.99], ["glp-2-tirzepatide","30mg",28.26,164.99],
  ["glp-3-retatrutide","5mg",23.06,54.99], ["glp-3-retatrutide","10mg",24.05,94.99],
  ["glp-3-retatrutide","20mg",27.29,154.99], ["glp-3-retatrutide","30mg",30.26,199.99],
  ["cagrilintide","10mg",35.00,79.99],
  ["klow","80mg",35.00,109.99], ["glow","70mg",35.00,94.99],
  ["bpc-157","5mg",25.06,42.99], ["bpc-157","10mg",25.69,59.99],
  ["bpc-157-tb-500","20mg",33.98,74.99], ["kpv","10mg",31.47,49.99],
  ["ghk-cu","50mg",22.88,47.99], ["ghk-cu","100mg",28.82,74.99],
  ["thymosin-alpha-1","5mg",33.50,59.99],
  ["cjc-1295-ipamorelin","10mg",29.14,64.99], ["cjc-1295-no-dac","10mg",35.00,59.99],
  ["tesamorelin","10mg",34.14,74.99], ["ghrp-6","10mg",33.00,47.99], ["ghrp-2","5mg",33.00,47.99],
  ["hgh-gh-191","24iu",28.04,99.99], ["hgh-gh-191","36iu",30.74,139.99], ["igf-1-lr3","1mg",35.00,74.99],
  ["nad","500mg",26.87,54.99], ["nad","1000mg",29.21,89.99], ["ss-31","10mg",33.09,74.99],
  ["mots-c","10mg",25.20,54.99], ["epithalon","10mg",33.00,49.99], ["glutathione","1500mg",33.30,54.99],
  ["semax","10mg",30.39,49.99], ["selank","10mg",32.64,49.99], ["cerebrolysin","60mg",35.00,74.99],
  ["pinealon","10mg",35.00,49.99], ["dsip","10mg",33.00,44.99], ["dsip","15mg",33.00,54.99],
  ["5-amino-1mq","50mg",33.00,59.99], ["l-carnitine","6000mg",33.00,49.99],
  ["lipo-c","10ml",33.00,49.99], ["b12","10ml",33.00,49.99],
  ["pt-141","10mg",30.94,49.99], ["mt-2-melanotan-ii","10mg",27.83,47.99],
  ["kisspeptin","10mg",34.50,54.99], ["hcg","5000iu",33.00,54.99], ["snap-8","10mg",33.00,44.99],
].map(([slug,dose,cost,retail])=>({slug,dose,cost,retail}));

// Deliberate loss-leaders: the ENTRY dose of a multi-dose hero line. Keep cheap.
const LOSS_LEADERS = new Set([
  "glp-1-semaglutide|5mg","glp-2-tirzepatide|5mg","glp-3-retatrutide|5mg",
  "bpc-157|5mg","ghk-cu|50mg","nad|500mg",
]);

const FLOOR = 0.45;          // don't let any non-leader sit below this at base cost
const TARGET = 0.52;         // aim here when raising
const margin = (r,c)=>(r-c)/r;
// round UP to the next x.99
const to99 = (n)=>{ const base=Math.floor(n); return (base + (n-base>0.99?1.99:0.99)); };

const rows = [];
for (const d of DOSES){
  const key = `${d.slug}|${d.dose}`;
  const m = margin(d.retail,d.cost);
  const isLeader = LOSS_LEADERS.has(key);
  let rec = d.retail, note = "";
  if (isLeader){ note = "loss-leader (entry dose) — keep"; }
  else if (m < FLOOR){
    const want = d.cost / (1 - TARGET);   // retail for TARGET margin
    rec = to99(Math.max(want, d.cost/(1-FLOOR)));
    note = `raise: ${(m*100).toFixed(0)}%→${(margin(rec,d.cost)*100).toFixed(0)}%`;
  } else { note = "ok — keep"; }
  rows.push({ ...d, m, rec, changed: rec!==d.retail, note });
}

console.log("\n== RECOMMENDED REPRICE (base EVO cost) ==");
console.log("product / dose".padEnd(30)+"cost".padStart(8)+"cur".padStart(9)+"→ rec".padStart(10)+"  margin  note");
for (const r of rows){
  const flag = r.changed ? "»" : " ";
  console.log(`${flag} ${(r.slug+" "+r.dose).padEnd(28)}${("$"+r.cost.toFixed(2)).padStart(8)}${("$"+r.retail.toFixed(2)).padStart(9)}${("$"+r.rec.toFixed(2)).padStart(10)}  ${(margin(r.rec,r.cost)*100).toFixed(0).padStart(3)}%   ${r.note}`);
}
const changed = rows.filter(r=>r.changed);
console.log(`\n  ${changed.length} products repriced; ${rows.length-changed.length} unchanged.`);
const before = rows.reduce((s,r)=>s+r.m,0)/rows.length;
const after = rows.reduce((s,r)=>s+margin(r.rec,r.cost),0)/rows.length;
console.log(`  Blended merch margin: ${(before*100).toFixed(1)}% → ${(after*100).toFixed(1)}%`);

console.log("\n== APPLY SQL (updates the dose price AND the parent product price) ==\n");
console.log("-- Recommended reprice — review, then run in Supabase SQL Editor. Editable in Admin after.");
for (const r of changed){
  const cents = Math.round(r.rec*100);
  console.log(`update public.product_doses d set price_cents=${cents}, updated_at=now() from public.products p where p.id=d.product_id and p.slug='${r.slug}' and d.slug_suffix='${r.dose}';`);
}
// keep the parent product price in sync with its default dose
console.log("\n-- keep each parent product's headline price in sync with its default dose:");
console.log("update public.products p set price_cents = d.price_cents, updated_at=now() from public.product_doses d where d.product_id=p.id and d.is_default=true;");
