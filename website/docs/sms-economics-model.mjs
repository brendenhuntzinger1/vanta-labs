// Analysis model for the SMS blueprint — NOT production code, never imported.
// Every constant below is read from production source or the live database.
//
//   COGS ratio 0.1883            measured: revenue-weighted default doses, 2026-09-11
//   GHK-Cu 50mg  $39.99 / $3.65  product_doses, live
//   processing   8%              PROCESSING_FEE_DEFAULT_PERCENT
//   postage      $7.93           FALLBACK_POSTAGE_CENTS
//   bundle       5/8/12/20%      DEFAULT_BUNDLE_CONFIG (2 / 3-4 / 5-9 / 10+)
//   free ship    $200 / $15      FREE_SHIPPING_THRESHOLD / DOMESTIC_SHIPPING_FEE
//   tiers        Pro 8% Elite 10% Black 12%   membership_tiers, live (Essential INACTIVE)
//   points       2/3/4/5 per $   membership_tiers.points_per_dollar; 100 pts = $1
//   referral     10% customer    commission 10/12/15/20 by tier
//   personal     20%             DEFAULT_AMBASSADOR_PERSONAL_DISCOUNT_PERCENT

const COGS = 0.1883, PROC = 0.08, POSTAGE = 7.93;
const GIFT_RETAIL = 39.99, GIFT_COST = 3.65;
const FREE_SHIP_AT = 200, SHIP_FEE = 15;
const r = (v) => Math.round(v * 100) / 100;

const bundleRate = (n) => (n >= 10 ? 0.20 : n >= 5 ? 0.12 : n >= 3 ? 0.08 : n >= 2 ? 0.05 : 0);

// Baskets: list subtotal and unit count, so the bundle tier is realistic.
const BASKETS = [
  { label: "$50",    units: 1,  listUnit: 49.99 },
  { label: "$100",   units: 2,  listUnit: 49.99 },
  { label: "$150",   units: 2,  listUnit: 74.99 },
  { label: "$250",   units: 4,  listUnit: 62.49 },
  { label: "$500",   units: 7,  listUnit: 71.43 },
  { label: "$1,000", units: 14, listUnit: 71.43 },
];

// Price a basket the way quoteOrder does: bundle pricing baked into the line
// price, so `subtotal` is already net of it.
function priceBasket(units, listUnit) {
  const rate = bundleRate(units);
  const unit = r(listUnit * (1 - rate));
  return { units, listUnit, subtotal: r(unit * units), listSubtotal: r(listUnit * units), bundleRate: rate, unit };
}

// The discount contest: one winner, greatest savings, competed against the
// bundle savings already inside `subtotal` (profit-engine `compete`).
function resolveDiscount({ listSubtotal, subtotal, referralPct = 0, memberPct = 0, personalPct = 0 }) {
  const alreadyGranted = r(listSubtotal - subtotal);
  const compete = (raw) => Math.max(0, r(raw - alreadyGranted));
  const cands = [
    { type: "referral",       raw: r(listSubtotal * referralPct / 100) },
    { type: "member_pricing", raw: r(listSubtotal * memberPct   / 100) },
    { type: "personal",       raw: r(listSubtotal * personalPct / 100) },
  ];
  let best = null, bestEff = 0;
  for (const c of cands) { const eff = compete(c.raw); if (eff > bestEff) { best = c; bestEff = eff; } }
  return { winner: best?.type ?? null, discountAmount: r(bestEff) };
}

// Apply an SMS free_product gift, in both of the two shapes quoteOrder produces.
//   "add"    - product not in the cart: a $0 line is appended. subtotal UNCHANGED.
//   "absorb" - product already in the cart: units leave the paid lines AND the
//              survivors are repriced to the lower quantity's bundle tier
//              (quote-order.ts:934-942). subtotal falls by BOTH effects.
function applyGift(basket, mode) {
  if (mode === "none") return { ...basket, giftDisplaced: 0, giftCost: 0 };
  if (mode === "add") return { ...basket, giftDisplaced: 0, giftCost: GIFT_COST };
  const units = basket.units - 1;
  const after = priceBasket(units, basket.listUnit);
  return {
    ...after, units,
    giftDisplaced: r(basket.subtotal - after.subtotal), // the FULL delta the gift caused
    giftCost: GIFT_COST,
  };
}

// ---------------------------------------------------------------------------
// The three bases. This is the D1/D5 proposal.
// ---------------------------------------------------------------------------
function bases({ subtotal, discountAmount, giftDisplaced }) {
  // 1. UNCHANGED. Today's commissionableSubtotal. Refund proration + amount_paid.
  const paidMerchandise = r(Math.max(0, subtotal - discountAmount));
  // 2. Points / store-credit earning. Paid merchandise only; never gift value.
  const rewardBase = paidMerchandise;
  // 3. Commission. Paid merchandise + revenue the Vanta-funded gift displaced.
  const commissionableBase = r(paidMerchandise + giftDisplaced);
  return { paidMerchandise, rewardBase, commissionableBase };
}

function economics(b, { commissionPct = 0, pointsPerDollar = 0, storeCredit = 0, creditMinOrder = 0, freeShipMember = false }) {
  const ship = freeShipMember || b.paidMerchandise >= FREE_SHIP_AT ? 0 : SHIP_FEE;
  const revenue = r(b.paidMerchandise + ship);
  const cogs = r(b.subtotal * COGS);
  const commissionNow = r(b.paidMerchandise * commissionPct / 100);
  const commissionNew = r(b.commissionableBase * commissionPct / 100);
  const pointsNow = Math.floor(b.paidMerchandise * pointsPerDollar);  // earned on today's base
  const pointsNew = Math.floor(b.rewardBase * pointsPerDollar);       // earned on the reward base
  const pointsCost = r(pointsNew / 100);
  // PRODUCTION: resolveStoreCreditCents gates on `subtotalCents` = the POST-gift
  // subtotal. A gift that absorbs units can therefore push a member under their
  // tier's minimum and silently cost them their credit.
  const creditNow = b.subtotal >= creditMinOrder ? Math.min(storeCredit, b.paidMerchandise) : 0;
  // PROPOSED: gate on the reward base + the value the gift displaced, so the
  // gift cannot move eligibility. Redemption is still capped at what is owed.
  const creditNew = r(b.subtotal + b.giftDisplaced) >= creditMinOrder ? Math.min(storeCredit, b.paidMerchandise) : 0;
  const credit = creditNew;
  const contribNow = r(revenue - cogs - b.giftCost - revenue * PROC - commissionNow - POSTAGE - pointsNow / 100 - credit);
  const contribNew = r(revenue - cogs - b.giftCost - revenue * PROC - commissionNew - POSTAGE - pointsNew / 100 - credit);
  return { ship, revenue, cogs, commissionNow, commissionNew, pointsNow, pointsNew, pointsCost, credit, creditNow, creditNew, contribNow, contribNew };
}

function run(basket, mode, opts = {}) {
  const priced = priceBasket(basket.units, basket.listUnit);
  const withGift = applyGift(priced, mode);
  const d = resolveDiscount({ listSubtotal: withGift.listSubtotal ?? priced.listSubtotal, ...withGift, ...opts });
  const b = { ...withGift, discountAmount: d.discountAmount, ...bases({ ...withGift, discountAmount: d.discountAmount }) };
  return { basket, mode, winner: d.winner, ...b, ...economics(b, opts) };
}

const money = (v) => (v < 0 ? `-$${Math.abs(v).toFixed(2)}` : `$${v.toFixed(2)}`);

console.log("\n## 2. Before / after by basket size — ambassador referral (10% off, 15% commission), gift ABSORBS a unit\n");
console.log("`comm IDEAL` is what the ambassador would have earned on the SAME basket with NO gift.");
console.log("The proposal is correct exactly when `comm NEW` lands on it.\n");
console.log("| Basket | units after | subtotal | paid merch | gift displaced | commissionable | comm NOW | comm NEW | comm IDEAL | residual | contribution |");
console.log("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
for (const bk of BASKETS) {
  const o = run(bk, "absorb", { referralPct: 10, commissionPct: 15, pointsPerDollar: 2 });
  const ideal = run(bk, "none", { referralPct: 10, commissionPct: 15, pointsPerDollar: 2 }).commissionNow;
  console.log(`| ${bk.label} | ${o.units} | ${money(o.subtotal)} | ${money(o.paidMerchandise)} | ${money(o.giftDisplaced)} | ${money(o.commissionableBase)} | ${money(o.commissionNow)} | ${money(o.commissionNew)} | ${money(ideal)} | ${money(r(o.commissionNew - ideal))} | ${money(o.contribNew)} |`);
}

console.log("\n## 2b. Same baskets, gift ADDED (product not already in cart) — proves no double-count\n");
console.log("| Basket | subtotal | paid merch | gift displaced | comm NOW | comm NEW | delta |");
console.log("|---|--:|--:|--:|--:|--:|--:|");
for (const bk of BASKETS) {
  const o = run(bk, "add", { referralPct: 10, commissionPct: 15, pointsPerDollar: 2 });
  console.log(`| ${bk.label} | ${money(o.subtotal)} | ${money(o.paidMerchandise)} | ${money(o.giftDisplaced)} | ${money(o.commissionNow)} | ${money(o.commissionNew)} | ${money(r(o.commissionNew - o.commissionNow))} |`);
}

console.log("\n## 2c. NO SMS gift at all — proves existing orders are byte-identical\n");
console.log("| Basket | subtotal | discount | winner | paid merch | reward base | commissionable | comm NOW | comm NEW | identical? |");
console.log("|---|--:|--:|:--|--:|--:|--:|--:|--:|:--|");
for (const bk of BASKETS) {
  const o = run(bk, "none", { referralPct: 10, commissionPct: 15, pointsPerDollar: 2 });
  const same = o.commissionNow === o.commissionNew && o.rewardBase === o.paidMerchandise && o.commissionableBase === o.paidMerchandise;
  console.log(`| ${bk.label} | ${money(o.subtotal)} | ${money(o.discountAmount)} | ${o.winner ?? "none"} | ${money(o.paidMerchandise)} | ${money(o.rewardBase)} | ${money(o.commissionableBase)} | ${money(o.commissionNow)} | ${money(o.commissionNew)} | ${same ? "YES" : "** NO **"} |`);
}

console.log("\n## 4. Vanta Pro (8%, free shipping, 3 pts/$, $15 credit @ $100 min) + SMS gift\n");
console.log("| Basket | mode | winner | subtotal | paid merch | credit | points NOW | points NEW | gift COGS | contribution |");
console.log("|---|:--|:--|--:|--:|--:|--:|--:|--:|--:|");
for (const bk of BASKETS) for (const mode of ["none", "absorb"]) {
  const o = run(bk, mode, { memberPct: 8, pointsPerDollar: 3, storeCredit: 15, creditMinOrder: 100, freeShipMember: true });
  console.log(`| ${bk.label} | ${mode} | ${o.winner ?? "bundle only"} | ${money(o.subtotal)} | ${money(o.paidMerchandise)} | ${money(o.creditNow)} → ${money(o.creditNew)} | ${o.pointsNow} | ${o.pointsNew} | ${money(o.giftCost)} | ${money(o.contribNew)} |`);
}

console.log("\n## 6. Worst-case LEGITIMATE stack — Vanta Black + ambassador referral + gift + credit + points\n");
console.log("| Basket | subtotal | discount | paid merch | commissionable | commission | credit | points $ | gift | contribution |");
console.log("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
for (const bk of BASKETS) {
  const o = run(bk, "absorb", { referralPct: 10, memberPct: 12, commissionPct: 20, pointsPerDollar: 5, storeCredit: 75, creditMinOrder: 250, freeShipMember: true });
  console.log(`| ${bk.label} | ${money(o.subtotal)} | ${money(o.discountAmount)} | ${money(o.paidMerchandise)} | ${money(o.commissionableBase)} | ${money(o.commissionNew)} | ${money(o.credit)} | ${money(o.pointsCost)} | ${money(o.giftCost)} | ${money(o.contribNew)} |`);
}
