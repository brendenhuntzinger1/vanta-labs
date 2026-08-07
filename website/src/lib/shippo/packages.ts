import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

// -------------------------------------------------------------------------
// Package presets — the box half of a parcel.
//
// Shippo prices dimensions as well as weight (dimensional weight, USPS cubic
// tiers), so "which box is this going in" is a real input to what the store
// pays for postage. The owner ships out of a handful of mailer types, so they
// are ROWS rather than constants: swapping a box is a settings edit, not a
// deploy.
//
// Two invariants shape every function here:
//
//   1. AT MOST ONE DEFAULT. The database enforces it with a partial unique
//      index (shipping_package_presets_single_default), which means a naive
//      "set is_default = true" on a second row FAILS rather than silently
//      creating an ambiguous default. Every promotion below therefore clears
//      the incumbent first, in that order.
//   2. THERE SHOULD ALWAYS BE A DEFAULT. Parcel math resolves "this order names
//      no preset" to the default row, so deactivating the default has to hand
//      the crown to another active preset rather than leaving none. If it truly
//      cannot (no active presets left), parcel.ts still falls back to
//      FALLBACK_PACKAGE_PRESET, so a label is never blocked — but that fallback
//      is a safety net, not a plan.
//
// Nothing here throws. Every failure is a typed result carrying a sentence an
// admin can act on, because these are all reached from dashboard buttons.
// -------------------------------------------------------------------------

const PRESET_COLUMNS =
  "id, name, length_in, width_in, height_in, empty_weight_oz, is_default, is_active, created_at, updated_at";

/** Longest name the admin picker renders without truncating awkwardly. */
const MAX_PRESET_NAME_LENGTH = 80;

/**
 * Carriers reject a parcel dimension below roughly half an inch, and Shippo
 * refuses it outright with "Invalid height" before any rate is quoted.
 *
 * This exists because a real preset was saved at 0.2in high — the flat,
 * unpacked thickness of an empty mailer. An empty mailer is not what ships;
 * two vials inside it is, and that is nearer an inch. Accepting the flat
 * measurement produced an order that reached Shippo and then could not be
 * quoted, which is a worse failure than refusing the value here.
 */
const MIN_DIMENSION_IN = 0.5;
/** Longest side any common carrier accepts without freight handling. */
const MAX_DIMENSION_IN = 108;

export interface PackagePresetRecord {
  id: string;
  name: string;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  /** Tare weight of the EMPTY box. Added once per parcel, never per item. */
  emptyWeightOz: number;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export type PackagePresetResult<T> = { ok: true; data: T } | { ok: false; message: string };

function fail(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

/**
 * `numeric` columns come back from PostgREST as either a number or a string
 * depending on the driver, and admin form values are always strings. One
 * coercion here beats every call site remembering to do it — a forgotten
 * Number() turns a comparison into string ordering and a sum into
 * concatenation.
 */
function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapPreset(row: Record<string, unknown>): PackagePresetRecord {
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    lengthIn: num(row.length_in),
    widthIn: num(row.width_in),
    heightIn: num(row.height_in),
    emptyWeightOz: num(row.empty_weight_oz),
    isDefault: row.is_default === true,
    isActive: row.is_active !== false,
    createdAt: row.created_at == null ? null : String(row.created_at),
    updatedAt: row.updated_at == null ? null : String(row.updated_at),
  };
}

export interface PackagePresetInput {
  name: string;
  lengthIn: number | string;
  widthIn: number | string;
  heightIn: number | string;
  emptyWeightOz?: number | string | null;
  isDefault?: boolean;
  isActive?: boolean;
}

interface ValidatedPresetFields {
  name: string;
  length_in: number;
  width_in: number;
  height_in: number;
  empty_weight_oz: number;
}

/**
 * Validate an admin-entered box.
 *
 * Dimensions must be strictly positive: Shippo rejects a zero dimension, and a
 * negative one would sail past a `> 0`-less check and produce a parcel that
 * quotes wrong rather than erroring. `emptyWeightOz` is the one field where 0 is
 * legitimate — a poly mailer really does weigh almost nothing — so only a
 * negative value is refused.
 */
function validatePresetFields(input: PackagePresetInput): PackagePresetResult<ValidatedPresetFields> {
  const name = String(input?.name ?? "").trim().slice(0, MAX_PRESET_NAME_LENGTH);
  if (!name) {
    return fail("Give the package a name so it can be picked from the list.");
  }

  const dimensions: Array<[keyof ValidatedPresetFields, unknown, string]> = [
    ["length_in", input?.lengthIn, "Length"],
    ["width_in", input?.widthIn, "Width"],
    ["height_in", input?.heightIn, "Height"],
  ];

  const parsed: Record<string, number> = {};
  for (const [column, raw, label] of dimensions) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      return fail(`${label} must be a positive number of inches.`);
    }
    if (value < MIN_DIMENSION_IN) {
      return fail(
        `${label} of ${value}in is below the ${MIN_DIMENSION_IN}in carriers accept — Shippo will refuse to quote it. ` +
          `Measure the package with the order inside it, not flat and empty.`,
      );
    }
    if (value > MAX_DIMENSION_IN) {
      return fail(`${label} of ${value}in is larger than carriers accept without freight handling.`);
    }
    parsed[column] = value;
  }

  const emptyWeightRaw = input?.emptyWeightOz ?? 0;
  const emptyWeight = Number(emptyWeightRaw === "" || emptyWeightRaw === null ? 0 : emptyWeightRaw);
  if (!Number.isFinite(emptyWeight) || emptyWeight < 0) {
    return fail("Empty package weight must be zero or more ounces.");
  }

  return {
    ok: true,
    data: {
      name,
      length_in: parsed.length_in,
      width_in: parsed.width_in,
      height_in: parsed.height_in,
      empty_weight_oz: emptyWeight,
    },
  };
}

// --------------------------------------------------------------- reading ----

export interface ListPackagePresetOptions {
  /** Include retired boxes. Off by default — the picker only offers live ones. */
  includeInactive?: boolean;
}

/**
 * Every preset, default first then alphabetical, which is the order the admin
 * picker wants. Returns [] rather than throwing on a query failure: a settings
 * list that cannot load must not take down the order page it is embedded in.
 */
export async function listPackagePresets(options: ListPackagePresetOptions = {}): Promise<PackagePresetRecord[]> {
  let query = supabaseAdmin.from("shipping_package_presets").select(PRESET_COLUMNS);
  if (!options.includeInactive) {
    query = query.eq("is_active", true);
  }

  const { data, error } = await query.order("is_default", { ascending: false }).order("name", { ascending: true });
  if (error) {
    console.error("Unable to list shipping package presets", error);
    return [];
  }
  return (data ?? []).map((row) => mapPreset(row as Record<string, unknown>));
}

export async function getPackagePresetById(id: string | null | undefined): Promise<PackagePresetRecord | null> {
  const presetId = String(id ?? "").trim();
  if (!presetId) return null;

  const { data, error } = await supabaseAdmin
    .from("shipping_package_presets")
    .select(PRESET_COLUMNS)
    .eq("id", presetId)
    .maybeSingle();
  if (error) {
    console.error("Unable to load shipping package preset", presetId, error);
    return null;
  }
  return data ? mapPreset(data as Record<string, unknown>) : null;
}

/**
 * The box an order goes in when it names none.
 *
 * Deliberately does NOT filter on is_active: the unique index guarantees a
 * single default, and a default that has been retired is a configuration
 * mistake worth surfacing (the admin sees the retired box on the order) rather
 * than papering over by silently rating against some other box.
 */
export async function getDefaultPackagePreset(): Promise<PackagePresetRecord | null> {
  const { data, error } = await supabaseAdmin
    .from("shipping_package_presets")
    .select(PRESET_COLUMNS)
    .eq("is_default", true)
    .maybeSingle();
  if (error) {
    console.error("Unable to load the default shipping package preset", error);
    return null;
  }
  return data ? mapPreset(data as Record<string, unknown>) : null;
}

// --------------------------------------------------------------- writing ----

/**
 * Move the default flag onto one preset.
 *
 * The clear-then-set order is mandatory, not stylistic: the partial unique
 * index rejects a second `is_default = true`, so setting first would fail with
 * a constraint violation and leave the old default in place. Clearing first has
 * the opposite failure mode — a crash between the two writes leaves NO default,
 * which parcel.ts survives via FALLBACK_PACKAGE_PRESET. Of the two, "briefly no
 * default" is the recoverable one.
 */
export async function setDefaultPackagePreset(id: string): Promise<PackagePresetResult<PackagePresetRecord>> {
  const preset = await getPackagePresetById(id);
  if (!preset) {
    return fail("That package no longer exists.");
  }
  if (!preset.isActive) {
    return fail("Reactivate this package before making it the default.");
  }
  if (preset.isDefault) {
    return { ok: true, data: preset };
  }

  const now = new Date().toISOString();

  const { error: clearError } = await supabaseAdmin
    .from("shipping_package_presets")
    .update({ is_default: false, updated_at: now })
    .eq("is_default", true)
    .neq("id", preset.id);
  if (clearError) {
    console.error("Unable to clear the previous default package preset", clearError);
    return fail("Could not change the default package. Nothing was changed.");
  }

  const { error } = await supabaseAdmin
    .from("shipping_package_presets")
    .update({ is_default: true, updated_at: now })
    .eq("id", preset.id);
  if (error) {
    console.error("Unable to set the default package preset", preset.id, error);
    return fail("Could not set the default package. Pick a default again.");
  }

  return { ok: true, data: { ...preset, isDefault: true, updatedAt: now } };
}

/**
 * Create a box.
 *
 * Inserted with `is_default = false` even when the caller asked for a default,
 * then promoted through setDefaultPackagePreset. Going straight in as a default
 * would collide with the unique index whenever one already exists; promoting
 * afterwards also means a failed insert leaves the incumbent default untouched.
 */
export async function createPackagePreset(input: PackagePresetInput): Promise<PackagePresetResult<PackagePresetRecord>> {
  const validated = validatePresetFields(input);
  if (!validated.ok) return validated;

  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("shipping_package_presets")
    .insert({
      ...validated.data,
      is_default: false,
      is_active: input?.isActive !== false,
      created_at: now,
      updated_at: now,
    })
    .select(PRESET_COLUMNS)
    .single();

  if (error || !data) {
    console.error("Unable to create a shipping package preset", error);
    return fail("Could not save the package.");
  }

  const created = mapPreset(data as Record<string, unknown>);

  // First box in an empty table has to be the default, or nothing resolves.
  const shouldPromote = input?.isDefault === true || (await getDefaultPackagePreset()) === null;
  if (shouldPromote && created.isActive) {
    const promoted = await setDefaultPackagePreset(created.id);
    if (promoted.ok) return promoted;
  }

  return { ok: true, data: created };
}

export type PackagePresetPatch = Partial<PackagePresetInput>;

export async function updatePackagePreset(
  id: string,
  patch: PackagePresetPatch,
): Promise<PackagePresetResult<PackagePresetRecord>> {
  const preset = await getPackagePresetById(id);
  if (!preset) {
    return fail("That package no longer exists.");
  }

  // Validate the MERGED row, so a patch that only touches the name still can't
  // be accepted against dimensions that were never valid.
  const merged = validatePresetFields({
    name: patch.name ?? preset.name,
    lengthIn: patch.lengthIn ?? preset.lengthIn,
    widthIn: patch.widthIn ?? preset.widthIn,
    heightIn: patch.heightIn ?? preset.heightIn,
    emptyWeightOz: patch.emptyWeightOz ?? preset.emptyWeightOz,
  });
  if (!merged.ok) return merged;

  const now = new Date().toISOString();
  const isActive = patch.isActive ?? preset.isActive;

  const { data, error } = await supabaseAdmin
    .from("shipping_package_presets")
    .update({ ...merged.data, is_active: isActive, updated_at: now })
    .eq("id", preset.id)
    .select(PRESET_COLUMNS)
    .single();

  if (error || !data) {
    console.error("Unable to update the shipping package preset", preset.id, error);
    return fail("Could not save the package.");
  }

  const updated = mapPreset(data as Record<string, unknown>);

  if (patch.isDefault === true && isActive) {
    return setDefaultPackagePreset(updated.id);
  }
  // Deactivating the current default has to hand the default on, which is
  // exactly what deactivatePackagePreset does.
  if (!isActive && preset.isDefault) {
    return deactivatePackagePreset(updated.id);
  }

  return { ok: true, data: updated };
}

/**
 * Retire a box without deleting it.
 *
 * Never a hard delete: orders reference the preset they were rated against
 * (orders.package_preset_id), and losing that row loses the answer to "what box
 * did we quote this label from". Retiring the DEFAULT box promotes the
 * longest-standing remaining active preset, so parcel math keeps resolving.
 */
export async function deactivatePackagePreset(id: string): Promise<PackagePresetResult<PackagePresetRecord>> {
  const preset = await getPackagePresetById(id);
  if (!preset) {
    return fail("That package no longer exists.");
  }

  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("shipping_package_presets")
    .update({ is_active: false, is_default: false, updated_at: now })
    .eq("id", preset.id);
  if (error) {
    console.error("Unable to deactivate the shipping package preset", preset.id, error);
    return fail("Could not retire the package.");
  }

  if (preset.isDefault) {
    const remaining = await listPackagePresets();
    const successor = remaining.find((row) => row.id !== preset.id);
    if (successor) {
      await setDefaultPackagePreset(successor.id);
    } else {
      // Nothing left to promote. parcel.ts falls back to the standard mailer's
      // real dimensions, so labels still buy — but say so loudly, because the
      // store is now rating against a constant instead of a configured box.
      console.warn("No active shipping package presets remain; parcel math will use the built-in fallback.");
    }
  }

  return { ok: true, data: { ...preset, isActive: false, isDefault: false, updatedAt: now } };
}
