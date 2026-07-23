// ============================================================================
// VANTA LABS — MONTE CARLO PROFIT SIMULATION (10,000,000 orders)
// Uses the RECOMMENDED post-reprice catalog. Each order gets a random basket
// and a random mix of every real discount (referral, ambassador personal,
// membership %, fixed + percent coupons, buy-3-get-1 bundle) plus a random EVO
// wholesale tier. Applies the site's rules: ONE best discount, then the profit
// guard (never finalize below break-even). Reports the margin on ALL of them.
//   node scripts/pricing-montecarlo.mjs [N]
// ============================================================================

const N = Number(process.argv[2] || 10_000_000);

// Economics (match pricing-analysis.mjs; edit here, everything recomputes).
const PROC_PCT = 0.0595, PROC_FLAT = 0.30, SHIP_COST = 9.00;
const HANDLING = 0.07, SHIP_FEE = 15.00, FREE_SHIP = 250;
const REF_DISC = 0.10, PERSONAL_DISC = 0.15, COMMISSION = 0.15; // commission flat (per your choice)

// Post-reprice catalog: [cost, retail]. 51 doses.
const CAT = [
  [24.56,42.99],[25.37,64.99],[26.90,109.99],[27.80,144.99],       // GLP-1
  [23.76,47.99],[24.84,74.99],[26.46,124.99],[28.26,164.99],       // GLP-2
  [23.06,54.99],[24.05,94.99],[27.29,154.99],[30.26,199.99],       // GLP-3
  [35.00,79.99],                                                    // Cagrilintide
  [35.00,109.99],[35.00,94.99],                                     // KLOW, GLOW
  [25.06,42.99],[25.69,59.99],[33.98,74.99],                        // BPC-157 x2, BPC+TB500
  [31.47,65.99],                                                    // KPV (repriced)
  [22.88,47.99],[28.82,74.99],                                      // GHK-Cu x2
  [33.50,69.99],                                                    // Thymosin (repriced)
  [29.14,64.99],[35.00,72.99],[34.14,74.99],                        // CJC+Ipa, CJC noDAC*, Tesa
  [33.00,68.99],[33.00,68.99],                                      // GHRP-6*, GHRP-2*
  [28.04,99.99],[30.74,139.99],[35.00,74.99],                       // HGH x2, IGF-1
  [26.87,54.99],[29.21,89.99],[33.09,74.99],[25.20,54.99],          // NAD x2, SS-31, MOTS-C
  [33.00,68.99],[33.30,69.99],                                      // Epithalon*, Glutathione*
  [30.39,63.99],[32.64,68.99],[35.00,74.99],[35.00,72.99],          // Semax*, Selank*, Cerebro, Pinealon*
  [33.00,68.99],[33.00,68.99],                                      // DSIP 10*, DSIP 15*
  [33.00,68.99],[33.00,68.99],[33.00,68.99],[33.00,68.99],          // 5-Amino*, L-Carn*, LIPO-C*, B12*
  [30.94,64.99],[27.83,57.99],[34.50,71.99],[33.00,68.99],[33.00,68.99], // PT-141*, MT-2*, Kiss*, HCG*, SNAP-8*
];
const NC = CAT.length;

// Fast PRNG (deterministic, no Date/Math.random dependency for reproducibility).
let seed = 123456789 >>> 0;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (arr) => arr[(rnd() * arr.length) | 0];

const COUPON_FIXED = [0, 0, 0, 10, 25, 50];
const COUPON_PCT   = [0, 0, 0, 0, 0.10, 0.15, 0.20];
const MEMBER_PCT   = [0, 0, 0.05, 0.10, 0.15];
const EVO_TIERS    = [0, 0, 0.20, 0.30]; // 0% common, then 20%/30% volume off

// Margin histogram buckets (% of revenue): index 0 = [<0], then 0-5,5-10,...,95-100
const BUCKETS = 22;
const hist = new Int32Array(BUCKETS);
let guardFires = 0, rawNeg = 0, sumMargin = 0, sumProfit = 0, sumRev = 0;
let minMargin = Infinity, maxMargin = -Infinity, worstProfit = Infinity;
let minCase = null;

for (let i = 0; i < N; i++) {
  // --- random basket: 1..5 line items, qty 1..3 ---
  const lines = 1 + ((rnd() * 5) | 0);
  let subtotal = 0, cogs = 0, units = 0, cheapest = Infinity;
  const evo = pick(EVO_TIERS);
  for (let l = 0; l < lines; l++) {
    const p = CAT[(rnd() * NC) | 0];
    const qty = 1 + ((rnd() * 3) | 0);
    subtotal += p[1] * qty;
    cogs += p[0] * (1 - evo) * qty;
    units += qty;
    if (p[1] < cheapest) cheapest = p[1];
  }

  // --- candidate discounts (site applies the single best) ---
  const referral = rnd() < 0.6;
  const personal = rnd() < 0.2;
  const memberPct = pick(MEMBER_PCT);
  const cFixed = pick(COUPON_FIXED);
  const cPct = pick(COUPON_PCT);
  const bundle = units >= 4 ? cheapest : 0; // buy-3-get-1: cheapest unit free

  let disc = 0;
  if (referral) disc = Math.max(disc, subtotal * REF_DISC);
  if (personal) disc = Math.max(disc, subtotal * PERSONAL_DISC);
  if (memberPct) disc = Math.max(disc, subtotal * memberPct);
  if (cFixed) disc = Math.max(disc, Math.min(subtotal, cFixed));
  if (cPct) disc = Math.max(disc, subtotal * cPct);
  if (bundle) disc = Math.max(disc, bundle);
  if (disc > subtotal) disc = subtotal;

  // --- order economics ---
  const k = referral ? COMMISSION : 0;
  const settle = (merch) => {
    const shipRev = merch >= FREE_SHIP ? 0 : SHIP_FEE;
    const custPays = merch * (1 + HANDLING) + shipRev;
    const proc = custPays * PROC_PCT + PROC_FLAT;
    const commission = merch * k;
    const profit = custPays - proc - cogs - commission - SHIP_COST;
    return { custPays, profit };
  };

  let merch = subtotal - disc;
  let r = settle(merch);

  // --- profit guard: never finalize below break-even (peel the discount) ---
  if (r.profit < 0) {
    rawNeg++;
    // profit is linear & increasing in merch; solve merch_min for profit>=0.
    const shipRev = merch >= FREE_SHIP ? 0 : SHIP_FEE;
    const coef = (1 + HANDLING) * (1 - PROC_PCT) - k;              // d(profit)/d(merch)
    // +$0.01 buffer so the guard floor is break-even-or-better (never a sub-cent loss).
    const mMin = (PROC_FLAT + cogs + SHIP_COST + 0.01 - shipRev * (1 - PROC_PCT)) / coef;
    merch = Math.min(subtotal, Math.max(merch, mMin));
    r = settle(merch);
    if (r.profit < -0.01) { merch = subtotal; r = settle(merch); } // fallback: drop discount
    guardFires++;
  }

  const margin = r.custPays > 0 ? r.profit / r.custPays : 0;
  sumMargin += margin; sumProfit += r.profit; sumRev += r.custPays;
  if (margin < minMargin) { minMargin = margin; }
  if (margin > maxMargin) maxMargin = margin;
  if (r.profit < worstProfit) { worstProfit = r.profit; minCase = { subtotal, disc, merch, profit: r.profit }; }

  let b = margin < 0 ? 0 : 1 + Math.min(20, (margin * 20) | 0);
  hist[b]++;
}

const pctOf = (n) => ((n / N) * 100).toFixed(4) + "%";
console.log(`\n==== VANTA LABS — ${N.toLocaleString()} ORDER MONTE CARLO (recommended prices) ====\n`);
console.log(`Average net margin (profit / revenue): ${(sumMargin / N * 100).toFixed(2)}%`);
console.log(`Average profit per order            : $${(sumProfit / N).toFixed(2)}`);
console.log(`Blended net margin (Σprofit/Σrev)    : ${(sumProfit / sumRev * 100).toFixed(2)}%`);
console.log(`Best order margin                   : ${(maxMargin * 100).toFixed(1)}%`);
console.log(`Worst FINALIZED order margin        : ${(minMargin * 100).toFixed(2)}%   (must be >= 0)`);
console.log(`Worst finalized profit              : $${worstProfit.toFixed(2)}`);
console.log("");
console.log(`Orders whose RAW discount would lose money : ${rawNeg.toLocaleString()} (${pctOf(rawNeg)})`);
console.log(`Orders the profit guard corrected          : ${guardFires.toLocaleString()} (${pctOf(guardFires)})`);
console.log(`Orders that FINALIZED at a loss            : ${hist[0].toLocaleString()} (${pctOf(hist[0])})  <-- must be 0`);
console.log("");
console.log("Net-margin distribution across ALL orders:");
const labels = ["  < 0% (loss)"];
for (let b = 1; b < BUCKETS; b++) labels.push(`  ${((b-1)*5).toString().padStart(2)}–${((b)*5).toString().padStart(3)}%`);
const maxCount = Math.max(...hist);
for (let b = 0; b < BUCKETS; b++) {
  if (hist[b] === 0 && b !== 0) continue;
  const bar = "█".repeat(Math.round((hist[b] / maxCount) * 40));
  console.log(`${labels[b].padEnd(12)} ${pctOf(hist[b]).padStart(10)}  ${bar}`);
}
console.log(`\nGUARANTEE: ${hist[0] === 0 ? "PASSED ✅ — zero orders finalized below break-even." : "FAILED — some orders lost money."}`);
if (minCase) console.log(`Tightest finalized order: subtotal $${minCase.subtotal.toFixed(2)}, discount peeled to $${minCase.disc.toFixed(2)} → profit $${minCase.profit.toFixed(2)}`);
