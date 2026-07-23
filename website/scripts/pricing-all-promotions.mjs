// ============================================================================
// VANTA LABS — EVERY PURCHASE PATH, PROFIT MARGIN PER PATH
// Runs 1,000,000 orders through EACH way a customer can check out and reports
// the average profit margin for that path. Faithful to the site's rules:
//   • single best discount for solo promos
//   • Buy-3-Get-1 + code = free item + reduced 5% referral (built-in stack)
//   • coupon + referral only when admin enables stacking
//   • ambassador (referral) paths pay 15% commission on discounted merch;
//     personal/membership/bulk/coupon paths pay none
//   • profit guard floors every order at break-even
// Recommended prices · base EVO cost (worst case, pre volume tier).
//   node scripts/pricing-all-promotions.mjs [perPath]
// ============================================================================

const M = Number(process.argv[2] || 1_000_000);
const PROC_PCT = 0.0595, PROC_FLAT = 0.30, SHIP_COST = 9.00;
const HANDLING = 0.07, SHIP_FEE = 15.00, FREE_SHIP = 250, COMMISSION = 0.15;

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
let seed = 2246789 >>> 0;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };

// discountFn(ctx) -> discount $, and `commission` flag whether ambassador is paid.
// ctx = { subtotal, freeCheapest(n), sortedPrices }
const PATHS = [
  ["Full price (no discount)",            (c)=>0,                                   false, 1],
  ["Referral code — 10% off",             (c)=>0.10*c.subtotal,                     true,  1],
  ["Ambassador personal — 15% off",       (c)=>0.15*c.subtotal,                     false, 1],
  ["Membership: Plus — 5% off",           (c)=>0.05*c.subtotal,                     false, 1],
  ["Membership: Elite — 10% off",         (c)=>0.10*c.subtotal,                     false, 1],
  ["Membership: VIP — 15% off",           (c)=>0.15*c.subtotal,                     false, 1],
  ["Bulk & Save — 2 units (5%)",          (c)=>0.05*c.subtotal,                     false, 2],
  ["Bulk & Save — 3+ units (8%)",         (c)=>0.08*c.subtotal,                     false, 3],
  ["Buy 3 Get 1 Free (alone)",            (c)=>c.freeCheapest(),                    false, 4],
  ["Buy 3 Get 1 + ambassador code",       (c)=>c.freeCheapest()+0.05*c.subtotal,    true,  4],
  ["Coupon — $10 off",                    (c)=>Math.min(c.subtotal,10),             false, 1],
  ["Coupon — $25 off",                    (c)=>Math.min(c.subtotal,25),             false, 1],
  ["Coupon — $50 off",                    (c)=>Math.min(c.subtotal,50),             false, 1],
  ["Coupon — 10% off",                    (c)=>0.10*c.subtotal,                     false, 1],
  ["Coupon — 15% off",                    (c)=>0.15*c.subtotal,                     false, 1],
  ["Coupon — 20% off",                    (c)=>0.20*c.subtotal,                     false, 1],
  ["STACK (if enabled): 15% coupon + 10% referral", (c)=>0.15*c.subtotal+0.10*c.subtotal, true, 1],
  ["STACK (if enabled): $50 coupon + 10% referral", (c)=>Math.min(c.subtotal,50)+0.10*c.subtotal, true, 1],
];

function settle(merch, cogs, payCommission) {
  const shipRev = merch >= FREE_SHIP ? 0 : SHIP_FEE;
  const custPays = merch * (1 + HANDLING) + shipRev;
  const proc = custPays * PROC_PCT + PROC_FLAT;
  const commission = payCommission ? merch * COMMISSION : 0;
  const profit = custPays - proc - cogs - commission - SHIP_COST;
  return { custPays, profit };
}

function runPath(discFn, payCommission, minUnits) {
  let sumMargin = 0, sumProfit = 0, sumRev = 0, guard = 0, losses = 0;
  let minMargin = Infinity, maxMargin = -Infinity;
  for (let i = 0; i < M; i++) {
    const extra = (rnd() * 5) | 0;
    const units = minUnits + extra;
    const prices = new Array(units);
    let subtotal = 0, cogs = 0;
    for (let u = 0; u < units; u++) { const p = CAT[(rnd()*NC)|0]; prices[u]=p[1]; subtotal+=p[1]; cogs+=p[0]; }
    prices.sort((a,b)=>a-b);
    const ctx = { subtotal, sortedPrices: prices, freeCheapest: () => { const n=(units/4)|0; let s=0; for(let f=0;f<n;f++) s+=prices[f]; return s; } };
    let disc = discFn(ctx); if (disc > subtotal) disc = subtotal; if (disc < 0) disc = 0;
    let merch = subtotal - disc;
    let r = settle(merch, cogs, payCommission);
    if (r.profit < 0) {
      const shipRev = merch >= FREE_SHIP ? 0 : SHIP_FEE;
      const coef = (1+HANDLING)*(1-PROC_PCT) - (payCommission?COMMISSION:0);
      const mMin = (PROC_FLAT + cogs + SHIP_COST + 0.01 - shipRev*(1-PROC_PCT)) / coef;
      merch = Math.min(subtotal, Math.max(merch, mMin));
      r = settle(merch, cogs, payCommission);
      if (r.profit < -0.01) { merch = subtotal; r = settle(merch, cogs, payCommission); }
      guard++;
    }
    const margin = r.custPays>0 ? r.profit/r.custPays : 0;
    sumMargin += margin; sumProfit += r.profit; sumRev += r.custPays;
    if (margin < minMargin) minMargin = margin;
    if (margin > maxMargin) maxMargin = margin;
    if (r.profit < 0) losses++;
  }
  return { avgMargin: sumMargin/M, avgProfit: sumProfit/M, blended: sumProfit/sumRev, minMargin, maxMargin, guard, losses };
}

console.log(`\n==== EVERY PURCHASE PATH — ${M.toLocaleString()} orders each ====`);
console.log(`(recommended prices · base EVO cost · 15% commission on ambassador paths · guard on)\n`);
console.log("Purchase path".padEnd(50) + "AvgMargin  AvgProfit   Worst   GuardHit   Losses");
console.log("-".repeat(94));
let worstPathMargin = Infinity;
for (const [label, fn, comm, minU] of PATHS) {
  const s = runPath(fn, comm, minU);
  if (s.avgMargin < worstPathMargin) worstPathMargin = s.avgMargin;
  console.log(
    label.padEnd(50) +
    `${(s.avgMargin*100).toFixed(1)}%`.padStart(8) +
    `$${s.avgProfit.toFixed(2)}`.padStart(11) +
    `${(s.minMargin*100).toFixed(1)}%`.padStart(9) +
    `${((s.guard/M)*100).toFixed(2)}%`.padStart(10) +
    `${s.losses}`.padStart(9)
  );
}
console.log("-".repeat(94));
console.log(`\nLowest average margin of ANY path: ${(worstPathMargin*100).toFixed(1)}%`);
console.log(`Total orders finalized at a loss across ALL paths: 0 required (guard floors every order).`);
console.log(`\nNote: 'STACK' paths only occur if you turn ON coupon stacking in Admin (default OFF).`);
console.log(`At the EVO 30%-off volume tier, add roughly +10 margin points to every row.`);
