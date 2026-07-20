"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CardProcessingFeeConfig, PaymentMethodConfig } from "@/lib/payment-methods";

type EditableMethod = {
  id: string;
  label: string;
  kind: string;
  enabled: boolean;
  handle: string;
  businessName: string;
  email: string;
  phone: string;
  qrImageUrl: string;
  memoNote: string;
  instructions: string; // one per line
};

function toEditable(method: PaymentMethodConfig): EditableMethod {
  return {
    id: method.id,
    label: method.label,
    kind: method.kind,
    enabled: method.enabled,
    handle: method.handle ?? "",
    businessName: method.businessName ?? "",
    email: method.email ?? "",
    phone: method.phone ?? "",
    qrImageUrl: method.qrImageUrl ?? "",
    memoNote: method.memoNote ?? "",
    instructions: (method.instructions ?? []).join("\n"),
  };
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block text-xs text-zinc-400">
      {label}
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="vl-input mt-1 w-full px-3 py-2 text-sm" />
    </label>
  );
}

export function AdminPaymentSettingsClient({
  methods,
  cardFee,
}: {
  methods: PaymentMethodConfig[];
  cardFee: CardProcessingFeeConfig;
}) {
  const router = useRouter();
  const [editable, setEditable] = useState<EditableMethod[]>(methods.map(toEditable));
  const [fee, setFee] = useState<CardProcessingFeeConfig>(cardFee);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const updateMethod = (id: string, patch: Partial<EditableMethod>) => {
    setEditable((current) => current.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const updates = [
        ...editable.map((m) => ({
          section: "payment_methods",
          key: m.id,
          value: {
            label: m.label,
            enabled: m.enabled,
            handle: m.handle,
            businessName: m.businessName,
            email: m.email,
            phone: m.phone,
            qrImageUrl: m.qrImageUrl,
            memoNote: m.memoNote,
            instructions: m.instructions.split("\n").map((line) => line.trim()).filter(Boolean),
          },
        })),
        {
          section: "payment_methods",
          key: "card_processing_fee",
          value: {
            enabled: fee.enabled,
            percentage: Number(fee.percentage) || 0,
            label: fee.label,
            noticeText: fee.noticeText,
          },
        },
      ];

      const res = await fetch("/api/admin/control", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!res.ok || !json.success) {
        setMessage(json.error ?? "Save failed");
        setSaving(false);
        return;
      }
      setMessage("Saved. Changes are live on checkout.");
      router.refresh();
    } catch {
      setMessage("Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-6 space-y-4">
      {/* Card processing fee */}
      <div className="vl-panel rounded-2xl p-5">
        <h2 className="text-lg font-semibold">Card Processing Fee</h2>
        <p className="mt-1 text-sm text-zinc-400">Applied to Credit/Debit Card orders only. Recommended methods never carry a fee.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={fee.enabled} onChange={(e) => setFee({ ...fee, enabled: e.target.checked })} className="h-4 w-4" />
            Charge a card fee
          </label>
          <label className="block text-xs text-zinc-400">Fee percentage (%)
            <input type="number" min={0} step="0.1" value={fee.percentage} onChange={(e) => setFee({ ...fee, percentage: Number(e.target.value) })} className="vl-input mt-1 w-full px-3 py-2 text-sm" />
          </label>
          <Field label="Fee label" value={fee.label} onChange={(v) => setFee({ ...fee, label: v })} placeholder="Card Processing Fee" />
          <label className="block text-xs text-zinc-400 sm:col-span-2">Notice text (leave blank to auto-generate from the percentage)
            <textarea value={fee.noticeText} onChange={(e) => setFee({ ...fee, noticeText: e.target.value })} rows={2} className="vl-input mt-1 w-full px-3 py-2 text-sm" placeholder="A 5% processing fee applies to Credit/Debit Card payments…" />
          </label>
        </div>
        <p className="mt-3 rounded-lg border border-amber-300/25 bg-amber-300/5 px-3 py-2 text-xs leading-5 text-amber-200/90">
          ⚠ Card surcharges are regulated in some regions and often prohibited on debit cards. Confirm compliance for where you operate, or disable the fee.
        </p>
      </div>

      {/* Per-method account details */}
      {editable.filter((m) => m.kind === "manual").map((m) => (
        <div key={m.id} className="vl-panel rounded-2xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">{m.label}</h2>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={m.enabled} onChange={(e) => updateMethod(m.id, { enabled: e.target.checked })} className="h-4 w-4" />
              Show at checkout
            </label>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Display label" value={m.label} onChange={(v) => updateMethod(m.id, { label: v })} />
            <Field label="Username / handle / $cashtag" value={m.handle} onChange={(v) => updateMethod(m.id, { handle: v })} placeholder="$YOURCASHTAG" />
            <Field label="Business name" value={m.businessName} onChange={(v) => updateMethod(m.id, { businessName: v })} placeholder="Your Business LLC" />
            <Field label="Email" value={m.email} onChange={(v) => updateMethod(m.id, { email: v })} placeholder="payments@yourbusiness.com" />
            <Field label="Phone" value={m.phone} onChange={(v) => updateMethod(m.id, { phone: v })} placeholder="(000) 000-0000" />
            <Field label="QR image path/URL" value={m.qrImageUrl} onChange={(v) => updateMethod(m.id, { qrImageUrl: v })} placeholder="/images/payments/cashapp-qr.svg" />
            <label className="block text-xs text-zinc-400 sm:col-span-2">Instructions (one step per line)
              <textarea value={m.instructions} onChange={(e) => updateMethod(m.id, { instructions: e.target.value })} rows={3} className="vl-input mt-1 w-full px-3 py-2 text-sm" />
            </label>
            <label className="block text-xs text-zinc-400 sm:col-span-2">Memo note (order-number reminder)
              <textarea value={m.memoNote} onChange={(e) => updateMethod(m.id, { memoNote: e.target.value })} rows={2} className="vl-input mt-1 w-full px-3 py-2 text-sm" />
            </label>
          </div>
          <p className="mt-2 text-xs text-zinc-500">Leave a field blank to hide it on the payment panel. Only fields with a value are shown to customers.</p>
        </div>
      ))}

      <div className="sticky bottom-4 flex items-center gap-3 rounded-2xl border border-white/10 bg-zinc-900/90 p-4 backdrop-blur">
        <button type="button" disabled={saving} onClick={save} className="vl-btn-primary px-5 py-2.5 text-sm disabled:opacity-50">
          {saving ? "Saving…" : "Save payment settings"}
        </button>
        {message ? <span className="text-sm text-zinc-300">{message}</span> : null}
      </div>
    </div>
  );
}
