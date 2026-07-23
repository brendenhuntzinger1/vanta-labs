// ============================================================================
// VANTA LABS — "BUY 3 GET 1 FREE" + AMBASSADOR CODE (10,000,000 orders)
// Models your site's ONE intentional discount stack exactly:
//   • Buy 3 Get 1: for every 4 units, the CHEAPEST unit is free
//     (calculateBuy3Get1Discount).
//   • Ambassador code on a bundle order adds a REDUCED referral % (default 5%,
//     not the full 10%) — resolveCustomerDiscount bundle bucket.
//   • The ambassador still earns commission on the discounted merchandise.
//   • Profit guard floors every order at break-even.
// Uses recommended post-reprice pricing + base EVO cost (worst case, pre volume tier).
//   node scripts/pricing-buy3get1-referral.mjs [N]
// ============================================================================

const N = Number(process.argv[2] || 10_000_000);
const PROC_PCT = 0.0595, PROC_FLAT = 0.30, SHIP_COST = 9.00;
const HANDLING = 0.07, SHIP_FEE = 15.00, FREE_SHIP = 250;
const BUNDLE_REFERRAL_PCT = 0.05;  // reduced referral % on a bundle order (admin default)
const COMMISSION = 0.15;           // ambassador commission (flat, per your choice)

// [cost, retail] post-reprice, 51 doses (same as pricing-montecarlo.mjs).
const CAT = [
  [24.56,42.99],[25.37,64.99],[26.90,109.99],[27.80,144.99],
  [23.76,47.99],[24.84,74.99],[26.46,124.99],[28.26,164.99],
  [23.06,54.99],[24.05,94.99],[27.29,154.99],[30.26,199.99],
  [35.00,79.99],[35.00,109.99],[35.00,94.99],
  [25.06,42.99],[25.69,59.99],[33.98,74.99],[31.47,65.99],
  [22.88,47.99],[28.82,74.99],[33.50,69.99],
  [29.14,64.99],[35.00,72.99],[34.14,74.99],[33.00,68.99],[33.00,68.99],
  [28.04,99.99],[30.74,139.99],[35.00,74.99],
  [26.87,54.99],[29.21,89.99],[33.09,74.99],[25.20,54.99],[33.00,68.99],[33.30,69.99],
  [30.39,63.99],[32.64,68.99],[35.00,74.99],[35.00,72.99],[33.00,68.99],[33.00,68.99],
  [33.00,68.99],[33.00,68.99],[33.00,68.99],[33.00,68.99],
  [30.94,64.99],[27.83,57.99],[34.50,71.99],[33.00,68.99],[33.00,68.99],
];
const NC = CAT.length;

let seed = 987654321 >>> 0;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };

const BUCKETS = 22;
const hist = new Int32Array(BUCKETS);
let guardFires = 0, sumMargin = 0, sumProfit = 0, sumRev = 0, sumDisc = 0, sumUnits = 0;
let minMargin = Infinity, maxMargin = -Infinity, worstProfit = Infinity, minCase = null;

for (let i = 0; i < N; i++) {
  // Every order qualifies for Buy 3 Get 1: 4..12 units.
  const units = 4 + ((rnd() * 9) | 0);
  const prices = new Array(units);
  let subtotal = 0, cogs = 0;
  for (let u = 0; u < units; u++) {
    const p = CAT[(rnd() * NC) | 0];
    prices[u] = p[1];
    subtotal += p[1];
    cogs += p[0];              // base EVO cost (0% volume tier = worst case)
  }
  // Buy 3 Get 1: cheapest floor(units/4) units are free.
  prices.sort((a, b) => a - b);
  const freeCount = (units / 4) | 0;
  let buy3get1 = 0;
  for (let f = 0; f < freeCount; f++) buy3get1 += prices[f];

  // Bundle bucket = free item(s) + reduced 5% referral on subtotal (the stack).
  let disc = buy3get1 + subtotal * BUNDLE_REFERRAL_PCT;
  if (disc > subtotal) disc = subtotal;

  const settle = (merch) => {
    const shipRev = merch >= FREE_SHIP ? 0 : SHIP_FEE;
    const custPays = merch * (1 + HANDLING) + shipRev;
    const proc = custPays * PROC_PCT + PROC_FLAT;
    const commission = merch * COMMISSION;   // ambassador earns on discounted merch
    const profit = custPays - proc - cogs - commission - SHIP_COST;
    return { custPays, profit };
  };

  let merch = subtotal - disc;
  let r = settle(merch);
  if (r.profit < 0) {                         // profit guard: peel to break-even+
    const shipRev = merch >= FREE_SHIP ? 0 : SHIP_FEE;
    const coef = (1 + HANDLING) * (1 - PROC_PCT) - COMMISSION;
    const mMin = (PROC_FLAT + cogs + SHIP_COST + 0.01 - shipRev * (1 - PROC_PCT)) / coef;
    merch = Math.min(subtotal, Math.max(merch, mMin));
    r = settle(merch);
    if (r.profit < -0.01) { merch = subtotal; r = settle(merch); }
    guardFires++;
  }

  const margin = r.custPays > 0 ? r.profit / r.custPays : 0;
  sumMargin += margin; sumProfit += r.profit; sumRev += r.custPays; sumDisc += (subtotal - merch); sumUnits += units;
  if (margin < minMargin) minMargin = margin;
  if (margin > maxMargin) maxMargin = margin;
  if (r.profit < worstProfit) { worstProfit = r.profit; minCase = { units, subtotal, disc: subtotal - merch, profit: r.profit }; }
  const b = margin < 0 ? 0 : 1 + Math.min(20, (margin * 20) | 0);
  hist[b]++;
}

const pctOf = (n) => ((n / N) * 100).toFixed(4) + "%";
console.log(`\n==== BUY 3 GET 1 FREE + AMBASSADOR CODE — ${N.toLocaleString()} ORDERS ====`);
console.log(`(recommended prices · base EVO cost · commission ${(COMMISSION*100)|0}% · reduced referral ${(BUNDLE_REFERRAL_PCT*100)|0}%)\n`);
console.log(`Average units / order            : ${(sumUnits / N).toFixed(1)}`);
console.log(`Average TOTAL discount / order   : $${(sumDisc / N).toFixed(2)}  (free item + 5% referral, guard-adjusted)`);
console.log(`Average net margin               : ${(sumMargin / N * 100).toFixed(2)}%`);
console.log(`Average profit / order           : $${(sumProfit / N).toFixed(2)}`);
console.log(`Blended net margin (Σprofit/Σrev) : ${(sumProfit / sumRev * 100).toFixed(2)}%`);
console.log(`Best order margin                : ${(maxMargin * 100).toFixed(1)}%`);
console.log(`Worst FINALIZED order margin     : ${(minMargin * 100).toFixed(2)}%   (must be >= 0)`);
console.log(`Worst finalized profit           : $${worstProfit.toFixed(2)}`);
console.log(`Orders the profit guard corrected: ${guardFires.toLocaleString()} (${pctOf(guardFires)})`);
console.log(`Orders that FINALIZED at a loss  : ${hist[0].toLocaleString()} (${pctOf(hist[0])})  <-- must be 0`);
console.log("\nNet-margin distribution:");
const labels = ["  < 0% (loss)"];
for (let b = 1; b < BUCKETS; b++) labels.push(`  ${((b-1)*5).toString().padStart(2)}–${((b)*5).toString().padStart(3)}%`);
const maxCount = Math.max(...hist);
for (let b = 0; b < BUCKETS; b++) {
  if (hist[b] === 0 && b !== 0) continue;
  console.log(`${labels[b].padEnd(12)} ${pctOf(hist[b]).padStart(10)}  ${"█".repeat(Math.round((hist[b]/maxCount)*40))}`);
}
console.log(`\nGUARANTEE: ${hist[0] === 0 ? "PASSED ✅ — zero orders finalized below break-even." : "FAILED"}`);

// Concrete worked examples the owner can eyeball.
function example(label, unitList) {
  let subtotal = 0, cogs = 0; const prices = [];
  for (const [cost, retail, q] of unitList) for (let i=0;i<q;i++){ subtotal+=retail; cogs+=cost; prices.push(retail); }
  const units = prices.length; prices.sort((a,b)=>a-b);
  const freeCount = (units/4)|0; let free=0; for(let f=0;f<freeCount;f++) free+=prices[f];
  const disc = free + subtotal*BUNDLE_REFERRAL_PCT; const merch = subtotal-disc;
  const shipRev = merch>=FREE_SHIP?0:SHIP_FEE; const custPays = merch*(1+HANDLING)+shipRev;
  const proc = custPays*PROC_PCT+PROC_FLAT; const commission = merch*COMMISSION;
  const profit = custPays-proc-cogs-commission-SHIP_COST;
  console.log(`\n  ${label}`);
  console.log(`    subtotal $${subtotal.toFixed(2)} | free item $${free.toFixed(2)} + 5% $${(subtotal*0.05).toFixed(2)} = discount $${disc.toFixed(2)}`);
  console.log(`    customer pays $${custPays.toFixed(2)} | your cost $${cogs.toFixed(2)} | ambassador earns $${commission.toFixed(2)}`);
  console.log(`    YOUR PROFIT $${profit.toFixed(2)}  (margin ${(profit/custPays*100).toFixed(1)}%)`);
}
console.log("\n---- Concrete examples ----");
example("4 × GLP-1 Semaglutide 10mg ($64.99)", [[25.37,64.99,4]]);
example("4 × B12 10mL ($68.99, high-cost item)", [[33.00,68.99,4]]);
example("4 × BPC-157 5mg ($42.99, cheapest loss-leader)", [[25.06,42.99,4]]);
example("8 × GLP-3 Retatrutide 10mg ($94.99)", [[24.05,94.99,8]]);
