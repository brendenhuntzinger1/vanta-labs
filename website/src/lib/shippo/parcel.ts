import type { ShippoParcel } from "@/lib/shippo/types";

// -------------------------------------------------------------------------
// Parcel math: how much a Vanta Labs order weighs and what box it goes in.
//
// PURE on purpose — no DB, no network, no `server-only`. Everything it needs is
// passed in, so the one calculation that decides what postage we buy can be
// exhaustively unit-tested (parcel.test.ts) instead of only being exercised by
// spending money at Shippo. The caller loads the rows; this decides the numbers.
//
// The stakes are asymmetric and that shapes every fallback below: an
// OVER-declared parcel costs a few cents extra, while an UNDER-declared one is
// postage due, a returned package, and a customer waiting. Wherever the data is
// missing or nonsense, this errs heavy.
// -------------------------------------------------------------------------

/**
 * Packaged weight of one unit when neither the dose nor the product declares
 * one — matches the `products.shipping_weight_oz` column default so a product
 * row that predates the column behaves identically to one that has it.
 *
 * MUST STAY IN SYNC with the SQL default in
 * src/lib/sql/self-fulfillment-shippo.sql. If the two disagree, a product
 * inserted before the column existed rates differently from an identical one
 * inserted after — a discrepancy that only shows up as postage that quietly
 * does not match the catalog.
 *
 * 0.36 oz is a 3ml peptide vial at 10 g -- gramsToOz(10), rounded up.
 *
 * NOT YET WEIGHED. 10 g is a plausible figure for a 3ml glass vial with
 * stopper and crimp (commonly 8-12 g empty; the peptide itself is milligrams),
 * but it is an estimate until one is put on a scale. Bacteriostatic water is
 * heavier and carries its own per-SKU value -- it is NOT covered by this
 * fallback.
 *
 * This is the ONE fallback that does not err heavy, deliberately: it is
 * MULTIPLIED by quantity, so padding it pushes multi-vial orders across a tier
 * boundary and overcharges every shipment. Per-parcel padding belongs on the
 * package preset's tare, which is added once — not here, where it compounds.
 */
export const DEFAULT_UNIT_WEIGHT_OZ = 0.36;

/**
 * Grams per ounce. Exact, not the 28.35 approximation — these values are
 * multiplied by quantity, so a rounding error compounds across a large order.
 */
export const GRAMS_PER_OZ = 28.349523125;

/**
 * Density used to bound the mass of a liquid unit's CONTENTS, in g/mL.
 *
 * Water. Not a guess and not a measurement of any particular product: an
 * aqueous solution is water plus dissolved solute, so its density is at or
 * above water's. Using 1.0 therefore yields a LOWER BOUND on the liquid's own
 * mass — the one direction that is safe to assume without a scale.
 */
export const LIQUID_DENSITY_G_PER_ML = 1.0;

/**
 * The container of a liquid unit — vial, stopper, crimp and label — in grams.
 *
 * MEASURED, not assumed. Owner measurement recorded 2026-08: every 10 mL liquid
 * vial weighs 1.06 oz complete. 1.06 oz is 30 g; the fluid inside is 10 g; so
 * the container is 20 g.
 *
 * This replaces an earlier estimate that reused DEFAULT_UNIT_WEIGHT_OZ as the
 * container allowance. That was wrong by construction — a 3 mL dry vial is not
 * the same object as a 10 mL liquid one, and using it made an unweighed liquid
 * resolve to 0.72 oz against a real 1.06 oz.
 */
export const LIQUID_VIAL_CONTAINER_G = 20;

/**
 * Does this dose label denote a liquid, and if so how many millilitres?
 *
 * Liquids are the one category the dry-vial default cannot cover, because the
 * contents of a dry vial weigh milligrams and the contents of a 10 mL vial
 * weigh ten grams — more than the vial. Matching is on the dose label because
 * that is where the catalogue records the unit ("10mL", "30 mL", "2ml").
 *
 * Deliberately narrow: `mg`, `iu` and `mcg` must NOT match, so a dry product is
 * never pushed onto the liquid path. Returns null for anything that is not
 * unambiguously a millilitre quantity.
 */
export function parseDoseVolumeMl(label: NumericLike): number | null {
  if (typeof label !== "string") return null;
  // A number immediately followed by ml/mL, with optional space. The negative
  // lookahead on a following letter keeps "5mlx" style junk out.
  const match = /(\d+(?:\.\d+)?)\s*m[lL]\b/.exec(label);
  if (!match) return null;
  const ml = Number(match[1]);
  return Number.isFinite(ml) && ml > 0 ? ml : null;
}

/**
 * Fallback weight for a LIQUID unit with no measured weight on file.
 *
 * = the measured container (LIQUID_VIAL_CONTAINER_G)
 * + the mass of the liquid it holds (volume x water density).
 *
 * INVENTS NOTHING. Both terms are real: the container is measured, and water
 * density is a physical constant. A 10 mL vial resolves to gramsToOz(10 + 20)
 * = 1.06 oz — exactly the owner's measured figure — rather than the 0.36 oz a
 * dry vial gets, which is the defect this guards: a 10 mL liquid was previously
 * declared at the weight of the fluid alone, with a weightless vial.
 *
 * For a volume other than 10 mL the container term is an extrapolation, so this
 * remains an ESTIMATE and is reported as one. It is what stops an unmeasured
 * liquid from being declared at an impossible weight; it is not a substitute
 * for a scale.
 *
 * This is still an ESTIMATE and is reported as one (`hasStoredWeight` is false
 * for these lines, exactly as before). It is not a substitute for putting the
 * unit on a scale; it is what stops an unmeasured liquid from being declared at
 * a weight that is physically impossible.
 *
 * Unlike DEFAULT_UNIT_WEIGHT_OZ this one DOES err heavy, and that asymmetry is
 * intentional: the dry default is a plausible figure for the thing it
 * describes, whereas any liquid rating at the dry figure is known-wrong.
 */
export function liquidFallbackWeightOz(volumeMl: number): number {
  const ml = Number(volumeMl);
  if (!Number.isFinite(ml) || ml <= 0) return DEFAULT_UNIT_WEIGHT_OZ;
  return gramsToOz(ml * LIQUID_DENSITY_G_PER_ML + LIQUID_VIAL_CONTAINER_G);
}

/**
 * Grams -> ounces, rounded UP to hundredths.
 *
 * Up, not nearest: a declared weight below the real one is what earns a carrier
 * adjustment, and the fraction of a cent that over-declaring costs is not worth
 * the exposure.
 */
export function gramsToOz(grams: number): number {
  const value = Number(grams);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil((value / GRAMS_PER_OZ) * 100) / 100;
}

/** Ounces -> grams, for display. The owner thinks and weighs in grams. */
export function ozToGrams(oz: number): number {
  const value = Number(oz);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * GRAMS_PER_OZ);
}

/**
 * Shippo rejects a parcel weighing zero or less with a validation error, which
 * would block the label entirely. A tenth of an ounce is the smallest weight
 * every carrier accepts.
 */
export const MIN_PARCEL_WEIGHT_OZ = 0.1;

export interface PackagePreset {
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  emptyWeightOz: number;
}

/**
 * The seeded 'Standard Vanta Mailer' (9 × 6 × 3 in, 1.5 oz empty).
 *
 * Used when an order names no preset and no default row comes back. A missing
 * seed row must not be able to block a label — the owner packs everything in
 * this mailer anyway, so the honest fallback is its real dimensions rather than
 * a refusal or a zero-size parcel Shippo would reject.
 */
export const FALLBACK_PACKAGE_PRESET: PackagePreset = {
  lengthIn: 9,
  widthIn: 6,
  heightIn: 3,
  emptyWeightOz: 1.5,
};

/**
 * Numeric columns arrive from PostgREST as numbers, but a `numeric` can also
 * come back as a string depending on the driver and the client, and admin form
 * input is a string too. Accepting both here beats every call site remembering
 * to coerce — a forgotten `Number()` turns into string concatenation and a
 * 60-ounce parcel.
 */
export type NumericLike = number | string | null | undefined;

/**
 * A `shipping_package_presets` row, accepted in either casing so a raw Supabase
 * row can be handed straight over without a mapping layer to drift out of sync.
 */
export interface PackagePresetLike {
  lengthIn?: NumericLike;
  length_in?: NumericLike;
  widthIn?: NumericLike;
  width_in?: NumericLike;
  heightIn?: NumericLike;
  height_in?: NumericLike;
  emptyWeightOz?: NumericLike;
  empty_weight_oz?: NumericLike;
}

/**
 * One order line's shipping facts.
 *
 * `doseWeightOz` is the dose/variant's own packaged weight and wins when set;
 * null means "inherit the parent product", which is exactly what a null
 * `product_doses.shipping_weight_oz` means in the schema.
 */
export interface ParcelLine {
  quantity?: NumericLike;
  doseWeightOz?: NumericLike;
  productWeightOz?: NumericLike;
  /** snake_case aliases, so a joined row can be passed through unmapped. */
  dose_shipping_weight_oz?: NumericLike;
  product_shipping_weight_oz?: NumericLike;
  /**
   * The dose/variant label ("10mL", "5mg"). Used ONLY when no weight is stored
   * anywhere, to tell a liquid unit apart from a dry one before falling back.
   * Absent means "treat as dry", which is the pre-existing behaviour.
   */
  doseLabel?: NumericLike;
  dose_label?: NumericLike;
}

export interface ParcelInput {
  /** The order's package_preset_id row, or the is_default row. */
  preset?: PackagePresetLike | null;
  items?: ParcelLine[] | null;
  /** `orders.parcel_weight_oz_override` — replaces the computed total entirely. */
  overrideOz?: NumericLike;
}

function toFiniteNumber(value: NumericLike): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A weight or dimension is only usable when it is a real positive number.
 *
 * Zero and negatives are treated as MISSING rather than honoured: a 0 in
 * `shipping_weight_oz` is a mis-typed row or an unfilled import, never a real
 * weightless vial, and honouring it would silently under-declare the parcel.
 */
function toPositiveNumber(value: NumericLike): number | null {
  const parsed = toFiniteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

/**
 * Round to hundredths of an ounce — finer than any carrier's granularity, and
 * enough to keep binary float noise (1.5 + 2.1 + 2.1 = 5.699999999999999) out of
 * the payload and out of the admin UI. The epsilon nudge stops a value that is
 * one ULP below the midpoint from rounding the wrong way.
 */
function roundHundredths(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Wire format: a plain decimal with no trailing zeros ("9", "7.5", "0.1"). */
function formatDecimal(value: number): string {
  return String(roundHundredths(value));
}

/**
 * Quantities are whole units. A fractional, negative, missing or unparseable
 * quantity contributes nothing rather than throwing — matching
 * planInventoryAdjustments() in inventory-fulfillment.ts, so a line that moves
 * no stock also adds no weight.
 */
function normalizedQuantity(line: ParcelLine | null | undefined): number {
  const parsed = toFiniteNumber(line?.quantity);
  if (parsed === null) return 0;
  const whole = Math.trunc(parsed);
  return whole > 0 ? whole : 0;
}

/**
 * Resolve the box. Each field falls back independently to the standard mailer,
 * so a half-populated preset row (a dimension left null by an admin) still
 * produces a parcel Shippo will price instead of a 400.
 *
 * `emptyWeightOz` is the one field where 0 is legitimate — a preset can weigh
 * nothing worth counting — so it only falls back when the value is absent or
 * negative.
 */
export function resolvePackagePreset(preset?: PackagePresetLike | null): PackagePreset {
  const emptyWeight = toFiniteNumber(preset?.emptyWeightOz ?? preset?.empty_weight_oz);
  return {
    lengthIn: toPositiveNumber(preset?.lengthIn ?? preset?.length_in) ?? FALLBACK_PACKAGE_PRESET.lengthIn,
    widthIn: toPositiveNumber(preset?.widthIn ?? preset?.width_in) ?? FALLBACK_PACKAGE_PRESET.widthIn,
    heightIn: toPositiveNumber(preset?.heightIn ?? preset?.height_in) ?? FALLBACK_PACKAGE_PRESET.heightIn,
    emptyWeightOz:
      emptyWeight !== null && emptyWeight >= 0 ? emptyWeight : FALLBACK_PACKAGE_PRESET.emptyWeightOz,
  };
}

/**
 * Packaged weight of ONE unit of a line — dose weight, else product weight, else
 * the default. Multiply by the quantity to get the line's contribution; this
 * deliberately does not, so the per-unit figure can be shown in the admin UI
 * next to each item.
 */
export function lineWeightOz(line: ParcelLine | null | undefined): number {
  // Dose wins over product, but neither returns early any more: both go through
  // the plausibility check below, because the backfill that produced the bad
  // value wrote it to the product row and a dose row can be edited by hand.
  const dose = toPositiveNumber(line?.doseWeightOz ?? line?.dose_shipping_weight_oz);
  const product = toPositiveNumber(line?.productWeightOz ?? line?.product_shipping_weight_oz);
  const volumeMl = parseDoseVolumeMl(line?.doseLabel ?? line?.dose_label);
  const stored = dose ?? product;

  if (stored !== null) {
    // A stored weight is normally the truth and is returned untouched. The one
    // exception is a value that is PHYSICALLY IMPOSSIBLE for the unit it
    // describes, which is not a measurement — it is a backfill or a typo.
    //
    // For a liquid the floor is unarguable: the fluid alone masses
    // volume x density, so a vial of it cannot weigh less than that even if the
    // glass were weightless. A 10 mL unit stored at 0.36 oz is exactly the mass
    // of the water with nothing holding it, which is how the catalogue-wide
    // backfill to the dry-vial figure shows up on a liquid SKU.
    //
    // Only impossible values are overridden. Anything at or above the fluid
    // floor is a real measurement and wins, including one LIGHTER than the
    // estimate below.
    if (volumeMl !== null && stored <= gramsToOz(volumeMl * LIQUID_DENSITY_G_PER_ML)) {
      return liquidFallbackWeightOz(volumeMl);
    }
    return stored;
  }

  // Nothing stored. Before using the dry-vial default, check whether this unit
  // is a liquid — for which that default is not merely imprecise but lighter
  // than the fluid the vial contains.
  if (volumeMl !== null) return liquidFallbackWeightOz(volumeMl);

  return DEFAULT_UNIT_WEIGHT_OZ;
}

/**
 * Is this line's weight a stored measurement, or a fallback estimate?
 *
 * Kept next to the resolution it describes so the two cannot drift. Callers use
 * it to show the operator which lines in a parcel are guesses.
 */
export function hasStoredWeight(line: ParcelLine | null | undefined): boolean {
  return (
    toPositiveNumber(line?.doseWeightOz ?? line?.dose_shipping_weight_oz) !== null ||
    toPositiveNumber(line?.productWeightOz ?? line?.product_shipping_weight_oz) !== null
  );
}

/**
 * Total declared weight in ounces: the empty package plus every unit in the box.
 *
 * The order-level override replaces the whole total — packaging included —
 * because it exists for the case where the owner put the order on a scale and
 * knows better than any computation. An override that is zero, negative or
 * unparseable is not an override, it is bad input, and falls back to the
 * computed weight rather than declaring a 0.1 oz parcel for a real shipment.
 */
export function computeParcelWeightOz(input: ParcelInput): number {
  const override = toPositiveNumber(input?.overrideOz);
  if (override !== null) {
    return Math.max(MIN_PARCEL_WEIGHT_OZ, roundHundredths(override));
  }

  const preset = resolvePackagePreset(input?.preset);
  // Packaging is added once for the parcel, never once per line — the order goes
  // in a single mailer.
  let total = preset.emptyWeightOz;
  for (const line of input?.items ?? []) {
    total += lineWeightOz(line) * normalizedQuantity(line);
  }

  return Math.max(MIN_PARCEL_WEIGHT_OZ, roundHundredths(total));
}

/**
 * The parcel exactly as Shippo wants it: preset dimensions in inches, computed
 * weight in ounces, everything as decimal strings.
 */
export function buildParcel(input: ParcelInput): ShippoParcel {
  const preset = resolvePackagePreset(input?.preset);
  return {
    length: formatDecimal(preset.lengthIn),
    width: formatDecimal(preset.widthIn),
    height: formatDecimal(preset.heightIn),
    distance_unit: "in",
    weight: formatDecimal(computeParcelWeightOz(input)),
    mass_unit: "oz",
  };
}
