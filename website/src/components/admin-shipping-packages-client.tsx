"use client";

import { useMemo, useState } from "react";
import type { PackagePresetRecord } from "@/lib/shippo/packages";

// ---------------------------------------------------------------------------
// Package presets — the boxes the store ships out of.
//
// Nothing here is hard-coded. Dimensions and the empty mailer's own weight go
// straight into every Shippo rate request (carriers price dimensional weight
// and USPS cubic tiers off them), so swapping to a different mailer has to be a
// settings edit the owner can make while standing at the packing table, not a
// code change.
//
// The single-default rule is the database's job, enforced by a partial unique
// index and by the clear-then-set ordering in lib/shippo/packages.ts. This
// component deliberately re-reads the whole list after every write instead of
// patching its own state: promoting one preset demotes another, and retiring
// the default promotes a successor, so the server is the only thing that knows
// the resulting shape of the list. Guessing it locally is how a UI ends up
// showing two defaults.
// ---------------------------------------------------------------------------

interface PresetForm {
  name: string;
  lengthIn: string;
  widthIn: string;
  heightIn: string;
  emptyWeightOz: string;
}

const BLANK_FORM: PresetForm = { name: "", lengthIn: "", widthIn: "", heightIn: "", emptyWeightOz: "" };

function formFromPreset(preset: PackagePresetRecord): PresetForm {
  return {
    name: preset.name,
    lengthIn: String(preset.lengthIn),
    widthIn: String(preset.widthIn),
    heightIn: String(preset.heightIn),
    emptyWeightOz: String(preset.emptyWeightOz),
  };
}

/**
 * Client-side validation exists to answer instantly, not to be the rule. The
 * authority is validatePresetFields() in lib/shippo/packages.ts — this only
 * saves the operator a round-trip on an obviously empty field.
 */
function validateForm(form: PresetForm): string | null {
  if (!form.name.trim()) return "Give the package a name so it can be picked from the list.";
  for (const [label, value] of [["Length", form.lengthIn], ["Width", form.widthIn], ["Height", form.heightIn]] as const) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return `${label} must be a positive number of inches.`;
  }
  const tare = form.emptyWeightOz.trim() === "" ? 0 : Number(form.emptyWeightOz);
  if (!Number.isFinite(tare) || tare < 0) return "Empty package weight must be zero or more ounces.";
  return null;
}

function toPayload(form: PresetForm) {
  return {
    name: form.name.trim(),
    lengthIn: Number(form.lengthIn),
    widthIn: Number(form.widthIn),
    heightIn: Number(form.heightIn),
    emptyWeightOz: form.emptyWeightOz.trim() === "" ? 0 : Number(form.emptyWeightOz),
  };
}

function DimensionFields({
  form,
  onChange,
  idPrefix,
}: {
  form: PresetForm;
  onChange: (next: PresetForm) => void;
  idPrefix: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label htmlFor={`${idPrefix}-name`} className="text-xs text-zinc-400 sm:col-span-2">
        Name
        <input
          id={`${idPrefix}-name`}
          value={form.name}
          onChange={(e) => onChange({ ...form, name: e.target.value })}
          placeholder="Standard Vanta Mailer"
          className="vl-input mt-1 w-full px-3 py-2.5 text-sm"
        />
      </label>
      <div className="grid grid-cols-3 gap-2 sm:col-span-2">
        {([["lengthIn", "Length (in)"], ["widthIn", "Width (in)"], ["heightIn", "Height (in)"]] as const).map(([key, label]) => (
          <label key={key} htmlFor={`${idPrefix}-${key}`} className="text-xs text-zinc-400">
            {label}
            <input
              id={`${idPrefix}-${key}`}
              inputMode="decimal"
              value={form[key]}
              onChange={(e) => onChange({ ...form, [key]: e.target.value })}
              className="vl-input mt-1 w-full px-3 py-2.5 text-sm"
            />
          </label>
        ))}
      </div>
      <label htmlFor={`${idPrefix}-tare`} className="text-xs text-zinc-400 sm:col-span-2">
        Empty package weight (oz)
        <input
          id={`${idPrefix}-tare`}
          inputMode="decimal"
          value={form.emptyWeightOz}
          onChange={(e) => onChange({ ...form, emptyWeightOz: e.target.value })}
          placeholder="1.5"
          className="vl-input mt-1 w-full px-3 py-2.5 text-sm"
        />
        <span className="mt-1 block text-[11px] text-zinc-500">
          The mailer on its own, with tape and filler but nothing in it. Added once per parcel — never per item.
        </span>
      </label>
    </div>
  );
}

export function AdminShippingPackagesClient({
  initialPackages,
  canManage,
}: {
  initialPackages: PackagePresetRecord[];
  canManage: boolean;
}) {
  const [packages, setPackages] = useState<PackagePresetRecord[]>(initialPackages);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<PresetForm>(BLANK_FORM);
  const [isAdding, setIsAdding] = useState(false);
  const [addForm, setAddForm] = useState<PresetForm>(BLANK_FORM);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const active = useMemo(() => packages.filter((preset) => preset.isActive), [packages]);
  const retired = useMemo(() => packages.filter((preset) => !preset.isActive), [packages]);
  const hasDefault = useMemo(() => packages.some((preset) => preset.isDefault), [packages]);

  /**
   * Re-read the list from the server after every write. See the note at the top
   * of this file: a write to one preset can change another.
   */
  const refresh = async () => {
    const res = await fetch("/api/admin/shipping/packages?includeInactive=1", { cache: "no-store" });
    const json = (await res.json()) as { success: boolean; packages?: PackagePresetRecord[]; error?: string };
    if (json.success && json.packages) {
      setPackages(json.packages);
    }
  };

  const request = async (
    input: RequestInfo,
    init: RequestInit,
    successMessage: string,
  ): Promise<boolean> => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(input, init);
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!res.ok || !json.success) {
        setMessage(json.error ?? "That didn't work. Nothing was changed.");
        return false;
      }
      await refresh();
      setMessage(successMessage);
      return true;
    } catch {
      setMessage("Unable to reach the server. Nothing was changed.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const createPreset = async () => {
    const invalid = validateForm(addForm);
    if (invalid) {
      setMessage(invalid);
      return;
    }
    const ok = await request(
      "/api/admin/shipping/packages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The first package in an empty table is promoted to default by the
        // server regardless, so this never has to be ticked to get a working
        // configuration.
        body: JSON.stringify({ ...toPayload(addForm), isDefault: false, isActive: true }),
      },
      `Added ${addForm.name.trim()}.`,
    );
    if (ok) {
      setAddForm(BLANK_FORM);
      setIsAdding(false);
    }
  };

  const saveEdit = async (preset: PackagePresetRecord) => {
    const invalid = validateForm(editForm);
    if (invalid) {
      setMessage(invalid);
      return;
    }
    const ok = await request(
      `/api/admin/shipping/packages/${preset.id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(toPayload(editForm)) },
      `Saved ${editForm.name.trim()}.`,
    );
    if (ok) {
      setEditingId(null);
    }
  };

  const makeDefault = async (preset: PackagePresetRecord) => {
    await request(
      `/api/admin/shipping/packages/${preset.id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "set_default" }) },
      `${preset.name} is now the default package.`,
    );
  };

  const setActive = async (preset: PackagePresetRecord, isActive: boolean) => {
    await request(
      `/api/admin/shipping/packages/${preset.id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive }) },
      isActive ? `${preset.name} is back in use.` : `${preset.name} retired.`,
    );
  };

  const retire = async (preset: PackagePresetRecord) => {
    // Say what will actually happen rather than asking "are you sure?". Losing
    // the last active box, or handing the default to a box the owner did not
    // choose, are both consequences worth naming before they occur.
    const consequence = active.length <= 1
      ? "This is your only package. Labels will fall back to a built-in 9 × 6 × 3 in mailer until you add another."
      : preset.isDefault
        ? "This is the default package. Another one will be made the default automatically — check which."
        : "Orders already rated against it keep their record.";
    if (!window.confirm(`Retire "${preset.name}"?\n\n${consequence}`)) {
      return;
    }
    await request(
      `/api/admin/shipping/packages/${preset.id}`,
      { method: "DELETE" },
      `${preset.name} retired.`,
    );
  };

  const startEditing = (preset: PackagePresetRecord) => {
    setEditingId(preset.id);
    setEditForm(formFromPreset(preset));
    setMessage(null);
  };

  const renderPreset = (preset: PackagePresetRecord) => {
    const isEditing = editingId === preset.id;

    return (
      <div
        key={preset.id}
        className={`rounded-xl border p-4 ${
          preset.isDefault
            ? "border-cyan-400/40 bg-cyan-400/[0.05]"
            : preset.isActive
              ? "border-white/10 bg-white/[0.02]"
              : "border-white/10 bg-white/[0.01] opacity-70"
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-100">
              {preset.name}
              {preset.isDefault ? (
                <span className="rounded-full border border-cyan-300/40 bg-cyan-300/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cyan-200">Default</span>
              ) : null}
              {!preset.isActive ? (
                <span className="rounded-full border border-white/20 bg-white/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Retired</span>
              ) : null}
            </p>
            <p className="mt-1 text-xs text-zinc-400">
              {preset.lengthIn} × {preset.widthIn} × {preset.heightIn} in · {preset.emptyWeightOz} oz empty
            </p>
          </div>

          {canManage && !isEditing ? (
            <div className="flex flex-wrap items-center gap-2">
              {preset.isActive && !preset.isDefault ? (
                <button type="button" disabled={busy} onClick={() => makeDefault(preset)} className="vl-btn-secondary px-3 py-1.5 text-xs disabled:opacity-50">
                  Make default
                </button>
              ) : null}
              <button type="button" disabled={busy} onClick={() => startEditing(preset)} className="vl-btn-secondary px-3 py-1.5 text-xs disabled:opacity-50">
                Edit
              </button>
              {preset.isActive ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => retire(preset)}
                  className="rounded-lg border border-rose-400/40 px-3 py-1.5 text-xs text-rose-200 hover:bg-rose-400/10 disabled:opacity-50"
                >
                  Retire
                </button>
              ) : (
                <button type="button" disabled={busy} onClick={() => setActive(preset, true)} className="vl-btn-secondary px-3 py-1.5 text-xs disabled:opacity-50">
                  Restore
                </button>
              )}
            </div>
          ) : null}
        </div>

        {isEditing ? (
          <div className="mt-4 border-t border-white/10 pt-4">
            <DimensionFields form={editForm} onChange={setEditForm} idPrefix={`edit-${preset.id}`} />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" disabled={busy} onClick={() => saveEdit(preset)} className="vl-btn-primary px-4 py-2 text-xs disabled:opacity-50">
                {busy ? "Saving…" : "Save package"}
              </button>
              <button type="button" disabled={busy} onClick={() => setEditingId(null)} className="vl-btn-secondary px-4 py-2 text-xs disabled:opacity-50">
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="vl-panel rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Packages</h2>
        {canManage ? (
          <button
            type="button"
            onClick={() => {
              setIsAdding((prev) => !prev);
              setMessage(null);
            }}
            className="vl-btn-secondary px-3 py-1.5 text-xs"
          >
            {isAdding ? "Cancel" : "Add package"}
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-zinc-400">
        The boxes and mailers you actually ship in. Carriers price the parcel&apos;s size as well as its weight, so
        these dimensions decide what postage costs. The <strong>default</strong> is used for any order that
        doesn&apos;t name a package.
      </p>

      {active.length === 0 ? (
        <p className="mt-3 rounded-xl border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-[13px] text-rose-100">
          <strong>No packages are in use.</strong> Labels will be rated against a built-in 9 × 6 × 3 in, 1.5 oz mailer
          until you add one. If that isn&apos;t what you ship in, the postage will be wrong.
        </p>
      ) : !hasDefault ? (
        <p className="mt-3 rounded-xl border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-[13px] text-amber-100">
          <strong>No default package is set.</strong> Pick one below, or orders that don&apos;t name a package will be
          rated against a built-in fallback.
        </p>
      ) : null}

      {message ? <p className="mt-3 text-sm text-zinc-300">{message}</p> : null}

      {isAdding && canManage ? (
        <div className="mt-4 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.04] p-4">
          <p className="text-sm font-semibold text-zinc-100">New package</p>
          <p className="mt-1 mb-3 text-[12px] text-zinc-400">
            Measure the box you ship in and weigh it empty. Both are used on every label bought against it.
          </p>
          <DimensionFields form={addForm} onChange={setAddForm} idPrefix="new-package" />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={createPreset} className="vl-btn-primary px-4 py-2 text-xs disabled:opacity-50">
              {busy ? "Saving…" : "Add package"}
            </button>
            <button type="button" disabled={busy} onClick={() => { setIsAdding(false); setAddForm(BLANK_FORM); }} className="vl-btn-secondary px-4 py-2 text-xs disabled:opacity-50">
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-4 space-y-3">
        {active.map(renderPreset)}
      </div>

      {retired.length > 0 ? (
        <div className="mt-5 border-t border-white/10 pt-4">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Retired</p>
          <p className="mt-1 text-[12px] text-zinc-500">
            Kept, not deleted — orders rated against these still point at them, which is the only record of what box
            their label was quoted from.
          </p>
          <div className="mt-3 space-y-3">
            {retired.map(renderPreset)}
          </div>
        </div>
      ) : null}

      {packages.length === 0 && !isAdding ? (
        <p className="mt-4 text-sm text-zinc-500">No packages yet.</p>
      ) : null}
    </div>
  );
}
