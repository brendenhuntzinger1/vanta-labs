"use client";

import { useState } from "react";
import type { ShippingAddress } from "@/lib/shipping-origin";

// The two addresses are genuinely different things and the form says so
// explicitly. Left implicit, the natural assumption is that one address covers
// both — which silently prints a home address on every parcel.

const FIELDS: Array<{ key: keyof ShippingAddress; label: string; required: boolean; hint?: string; half?: boolean }> = [
  { key: "name", label: "Name", required: true },
  { key: "company", label: "Company", required: false, hint: "Optional" },
  { key: "street1", label: "Street address", required: true },
  { key: "street2", label: "Apt / Suite / Unit", required: false, hint: "Optional" },
  { key: "city", label: "City", required: true, half: true },
  { key: "state", label: "State", required: true, hint: "Two letters, e.g. FL", half: true },
  { key: "zip", label: "ZIP", required: true, half: true },
  { key: "country", label: "Country", required: true, hint: "Two letters, e.g. US", half: true },
  { key: "phone", label: "Phone", required: true, hint: "UPS and FedEx reject shipments without one" },
  { key: "email", label: "Email", required: false, hint: "Optional" },
];

function AddressFields({
  value,
  onChange,
  idPrefix,
}: {
  value: ShippingAddress;
  onChange: (next: ShippingAddress) => void;
  idPrefix: string;
}) {
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      {FIELDS.map((field) => (
        <label
          key={field.key}
          htmlFor={`${idPrefix}-${field.key}`}
          className={`text-sm text-zinc-300 ${field.half ? "" : "sm:col-span-2"}`}
        >
          {field.label}
          {field.required ? <span className="ml-1 text-rose-300">*</span> : null}
          <input
            id={`${idPrefix}-${field.key}`}
            value={value[field.key]}
            onChange={(e) => onChange({ ...value, [field.key]: e.target.value })}
            className="vl-input mt-1 w-full px-3 py-2.5 text-sm"
            autoComplete="off"
          />
          {field.hint ? <span className="mt-1 block text-[11px] text-zinc-500">{field.hint}</span> : null}
        </label>
      ))}
    </div>
  );
}

export function AdminShippingOriginClient({
  initialOrigin,
  initialReturn,
  initialUsesSeparateReturn,
  initialOriginMissing,
}: {
  initialOrigin: ShippingAddress;
  initialReturn: ShippingAddress;
  initialUsesSeparateReturn: boolean;
  initialOriginMissing: string[];
}) {
  const [origin, setOrigin] = useState(initialOrigin);
  const [returnAddress, setReturnAddress] = useState(initialReturn);
  const [usesSeparateReturn, setUsesSeparateReturn] = useState(initialUsesSeparateReturn);
  const [originMissing, setOriginMissing] = useState(initialOriginMissing);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/shipping/origin", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin, returnAddress }),
      });
      const json = (await res.json()) as {
        success: boolean;
        error?: string;
        usesSeparateReturn?: boolean;
        originValidation?: { isComplete: boolean; missing: string[] };
      };
      if (!res.ok || !json.success) {
        setMessage(json.error ?? "Unable to save.");
        return;
      }
      setUsesSeparateReturn(Boolean(json.usesSeparateReturn));
      setOriginMissing(json.originValidation?.missing ?? []);
      setMessage(
        json.originValidation?.isComplete
          ? "Saved. Rates can be requested."
          : "Saved, but the origin is still incomplete — rates will be blocked until it is filled in.",
      );
    } catch {
      setMessage("Unable to save right now.");
    } finally {
      setSaving(false);
    }
  };

  // Exactly what toShippoAddress sends, in the order a label prints it. Blank
  // fields are dropped rather than rendered as empty lines, so the preview
  // matches the parcel instead of a form.
  const returnBlock = [
    returnAddress.name,
    returnAddress.company,
    returnAddress.street1,
    returnAddress.street2,
    [returnAddress.city, returnAddress.state].filter(Boolean).join(", "),
    returnAddress.zip,
  ]
    .map((line) => (line ?? "").trim())
    .filter(Boolean);

  return (
    <div className="vl-panel rounded-2xl p-5">
      <h2 className="text-lg font-semibold">Ship from &amp; return address</h2>
      <p className="mt-1 text-sm text-zinc-400">
        Stored in your admin settings, never in the codebase.
      </p>

      {originMissing.length > 0 ? (
        <p className="mt-3 rounded-xl border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-[13px] text-amber-100">
          Origin incomplete — still needed: <strong>{originMissing.join(", ")}</strong>. Shipping rates
          cannot be requested until every required field is set.
        </p>
      ) : null}

      <section className="mt-5 border-t border-white/10 pt-4">
        <h3 className="text-sm font-semibold text-zinc-100">Ship-from origin</h3>
        <p className="mt-1 text-[12px] text-zinc-500">
          Where parcels physically ship from. Carriers price on the real origin ZIP, so this must be
          accurate — a PO box here would misprice every shipment. It is not shown to customers when a
          separate return address is set below.
        </p>
        <AddressFields value={origin} onChange={setOrigin} idPrefix="origin" />
      </section>

      <section className="mt-6 border-t border-white/10 pt-4">
        <h3 className="text-sm font-semibold text-zinc-100">Customer-facing return address</h3>
        <p className="mt-1 text-[12px] text-zinc-500">
          What customers read off the parcel, and where undeliverable packages go back to. A PO box or
          business address is fine here. Leave blank to use the origin.
        </p>

        {!usesSeparateReturn ? (
          <p className="mt-3 rounded-xl border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-[13px] text-rose-100">
            <strong>No separate return address is set.</strong> Your ship-from origin will be printed on
            every parcel. If that address is your home, fill this in.
          </p>
        ) : null}

        <AddressFields value={returnAddress} onChange={setReturnAddress} idPrefix="return" />
        <p className="mt-2 text-[11px] text-zinc-500">
          Every required field must be set. Shipping is blocked while this is incomplete rather than
          falling back to your ship-from address — that fallback is how a home address ends up printed
          on a stranger&apos;s parcel.
        </p>

        {/*
          THE PREVIEW.
          Every field here is individually plausible, which is why a wrong one
          survives review: "brenden" looks fine sitting in a box labelled Name.
          Stacked as the customer will actually read it, a personal name at the
          top of a business return block is obvious in one glance. This renders
          exactly what Shippo is sent — name, then company, then the street
          lines — so what is shown is what gets printed.
        */}
        <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-4">
          <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">
            Printed on every parcel
          </p>
          {returnBlock.length > 0 ? (
            <pre className="mt-2 whitespace-pre-wrap font-mono text-[13px] leading-6 text-zinc-200">
              {returnBlock.join("\n")}
            </pre>
          ) : (
            <p className="mt-2 text-[13px] text-zinc-500">Fill in the fields above to see this.</p>
          )}
          <p className="mt-3 text-[11px] text-zinc-500">
            Read the top line. It should be your business name — customers see this, not your account
            name.
          </p>
        </div>
      </section>

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-white/10 pt-4">
        <button
          type="button"
          disabled={saving}
          onClick={save}
          className="vl-btn-primary px-5 py-2.5 text-sm disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save addresses"}
        </button>
        {message ? <p className="text-sm text-zinc-300">{message}</p> : null}
      </div>
    </div>
  );
}
