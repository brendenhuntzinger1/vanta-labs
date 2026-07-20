"use client";

import { useState } from "react";
import type { CustomerAddress } from "@/lib/customer-account";

const EMPTY_FORM = { label: "", fullName: "", address: "", city: "", postalCode: "" };

export function AccountAddressesClient({ initialAddresses }: { initialAddresses: CustomerAddress[] }) {
  const [addresses, setAddresses] = useState<CustomerAddress[]>(initialAddresses);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const handleAdd = async () => {
    setError(null);
    setMessage(null);

    if (!form.fullName.trim() || !form.address.trim() || !form.city.trim() || !form.postalCode.trim()) {
      setError("Full name, address, city, and postal code are required.");
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/account/addresses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!result.success) {
        setError(result.error ?? "Unable to save address.");
        return;
      }
      setForm(EMPTY_FORM);
      setMessage("Address saved.");
      window.location.reload();
    } catch {
      setError("Unable to save address right now.");
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefault = async (address: CustomerAddress) => {
    setBusyId(address.id);
    setError(null);
    try {
      const response = await fetch(`/api/account/addresses/${address.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isDefault: true }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!result.success) {
        setError(result.error ?? "Unable to update address.");
        return;
      }
      window.location.reload();
    } catch {
      setError("Unable to update address right now.");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (address: CustomerAddress) => {
    setBusyId(address.id);
    setError(null);
    try {
      const response = await fetch(`/api/account/addresses/${address.id}`, { method: "DELETE" });
      const result = await response.json() as { success: boolean; error?: string };
      if (!result.success) {
        setError(result.error ?? "Unable to delete address.");
        return;
      }
      setAddresses((prev) => prev.filter((item) => item.id !== address.id));
    } catch {
      setError("Unable to delete address right now.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      {addresses.map((address) => (
        <section key={address.id} className="vl-panel rounded-2xl p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              {address.label ? <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">{address.label}</p> : null}
              <p className="mt-1 text-sm font-semibold text-white">{address.fullName}</p>
              <p className="mt-1 text-sm text-zinc-400">{address.address}</p>
              <p className="text-sm text-zinc-400">{address.city}, {address.postalCode}</p>
            </div>
            <div className="flex flex-col items-end gap-2">
              {address.isDefault ? (
                <span className="rounded-full bg-emerald-400/15 px-2 py-1 text-xs text-emerald-300">Default</span>
              ) : (
                <button
                  type="button"
                  onClick={() => handleSetDefault(address)}
                  disabled={busyId === address.id}
                  className="text-xs text-cyan-300 underline-offset-4 hover:underline disabled:opacity-60"
                >
                  Set as default
                </button>
              )}
              <button
                type="button"
                onClick={() => handleDelete(address)}
                disabled={busyId === address.id}
                className="text-xs text-rose-300 underline-offset-4 hover:underline disabled:opacity-60"
              >
                Delete
              </button>
            </div>
          </div>
        </section>
      ))}

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Add a new address</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-zinc-300 sm:col-span-2">
            Label (optional)
            <input value={form.label} onChange={(e) => setForm((prev) => ({ ...prev, label: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" placeholder="Home, Office…" />
          </label>
          <label className="text-sm text-zinc-300 sm:col-span-2">
            Full name
            <input value={form.fullName} onChange={(e) => setForm((prev) => ({ ...prev, fullName: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" />
          </label>
          <label className="text-sm text-zinc-300 sm:col-span-2">
            Address
            <input value={form.address} onChange={(e) => setForm((prev) => ({ ...prev, address: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" />
          </label>
          <label className="text-sm text-zinc-300">
            City
            <input value={form.city} onChange={(e) => setForm((prev) => ({ ...prev, city: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" />
          </label>
          <label className="text-sm text-zinc-300">
            Postal code
            <input value={form.postalCode} onChange={(e) => setForm((prev) => ({ ...prev, postalCode: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" />
          </label>
        </div>
        {error ? <p className="mt-3 text-sm text-rose-300">{error}</p> : null}
        {message ? <p className="mt-3 text-sm text-emerald-300">{message}</p> : null}
        <button type="button" onClick={handleAdd} disabled={saving} className="vl-btn-primary vl-focus-ring mt-4 px-5 py-2.5 text-sm disabled:opacity-60">
          {saving ? "Saving…" : "Add address"}
        </button>
      </section>
    </div>
  );
}
