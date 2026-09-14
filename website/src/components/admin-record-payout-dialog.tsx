"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  PAYOUT_CHANNELS,
  PAYOUT_CHANNEL_LABELS,
  describePayoutDestination,
  isPayoutChannel,
  type PayoutChannel,
} from "@/lib/payout-channels";

// ---------------------------------------------------------------------------
// RECORDING A PAYOUT THE OWNER HAS ALREADY MADE.
//
// The money leaves by hand — Zelle, Cash App, cash — whenever the owner
// chooses, and this card writes it down. It does not move funds. Everything
// the owner needs to pay someone and then record it sits on one screen: where
// the ambassador asked to be paid, what is owed, and how the money went.
//
// There is no hold here. The nightly sweep's wait is its own business; a
// commission from two days ago is owed and paid like one from two months ago.
// This replaces three browser pop-ups (confirm, confirm, prompt) on a button
// that was disabled until the sweep had cleared the money.
// ---------------------------------------------------------------------------

function currency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

const HANDLE_PLACEHOLDER: Record<PayoutChannel, string> = {
  paypal: "PayPal email",
  venmo: "@username",
  cashapp: "$cashtag",
  zelle: "Phone number or email",
  cash: "Optional — who took it",
  other: "Where it went",
};

export type RecordPayoutTarget = {
  id: string;
  name: string;
  referralCode: string;
  status: string;
  payoutMethod: string | null;
  payoutHandle: string | null;
  /** Everything unpaid, whether or not the sweep has reached it yet. */
  amountOwed: number;
};

export type RecordedPayout = { amount: number; orderCount: number };

type DialogProps = {
  target: RecordPayoutTarget;
  minimumPayoutThreshold: number;
  onClose: () => void;
  onRecorded: (payout: RecordedPayout) => void | Promise<void>;
};

export function AdminRecordPayoutDialog({ target, minimumPayoutThreshold, onClose, onRecorded }: DialogProps) {
  const approved = target.status === "approved";
  const profileChannel = target.payoutMethod && isPayoutChannel(target.payoutMethod) ? target.payoutMethod : "";

  const [paidVia, setPaidVia] = useState<PayoutChannel | "">(profileChannel);
  const [paidTo, setPaidTo] = useState(profileChannel ? target.payoutHandle ?? "" : "");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Escape closes it; focus moves in so a keyboard user meets the card rather
  // than the table behind it. No scroll lock, for the reason the offer modal
  // gives: two components fighting over body overflow is how one of them
  // leaves the page unscrollable.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const total = roundMoney(target.amountOwed);
  const belowMinimum = total > 0 && total < minimumPayoutThreshold;
  const canSubmit = approved && confirmed && total > 0 && paidVia !== "" && !busy;
  const destination = describePayoutDestination(target.payoutMethod, target.payoutHandle);
  const statusLabel = target.status.replace(/_/g, " ");
  const titleId = `record-payout-${target.id}`;

  const changeChannel = (next: string) => {
    const channel = isPayoutChannel(next) ? next : "";
    setPaidVia(channel);
    // The profile handle only makes sense for the profile's own app.
    setPaidTo(channel && channel === profileChannel ? target.payoutHandle ?? "" : "");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/partners/${target.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "mark_paid",
          amount: total,
          confirmedTransferred: true,
          overrideMinimumThreshold: belowMinimum,
          paidVia,
          paidTo: paidTo.trim() || null,
          transactionReference: reference.trim() || null,
          note: note.trim() || undefined,
        }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json?.success) {
        throw new Error(typeof json?.error === "string" ? json.error : "Unable to record the payout.");
      }
      await onRecorded({
        amount: Number(json.payout?.amount ?? 0),
        orderCount: Number(json.payout?.orderCount ?? 0),
      });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to record the payout.");
    } finally {
      setBusy(false);
    }
  };

  return (
    // `whitespace-normal` and `text-left` are reset here on purpose: the button
    // that opens this can sit inside a `whitespace-nowrap` table cell or a
    // centred tile, and a fixed overlay still inherits both from wherever it
    // was rendered. Opened from the payout queue, every label ran into its
    // field on one line until this was set.
    <div className="fixed inset-0 z-[90] flex items-end justify-center whitespace-normal bg-black/70 p-4 text-left sm:items-center">
      <button type="button" className="absolute inset-0 h-full w-full cursor-pointer border-0 bg-transparent p-0" aria-label="Close" onClick={onClose} disabled={busy} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="vl-panel vl-focus-ring relative max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl p-5 text-zinc-100 sm:p-6"
      >
        <form onSubmit={submit} className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-300/80">Record payout</p>
              <h2 id={titleId} className="mt-1 text-xl font-semibold text-white">{target.name}</h2>
              <p className="font-mono text-xs text-zinc-500">{target.referralCode}</p>
            </div>
            <button type="button" onClick={onClose} disabled={busy} className="rounded-lg px-2 py-1 text-lg leading-none text-zinc-400 hover:text-white" aria-label="Close">×</button>
          </div>

          <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-3">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">They asked to be paid by</p>
            {destination ? (
              <p className="mt-1 text-base font-semibold text-white">{destination}</p>
            ) : (
              <p className="mt-1 text-sm text-amber-300">No payout method on file — ask {target.name} to add one in their dashboard, or record where you sent it below.</p>
            )}
          </div>

          <div className="space-y-2 rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-zinc-300">Amount owed</span>
              <span className="text-lg font-semibold text-cyan-200">{currency(total)}</span>
            </div>
            {belowMinimum ? (
              <p className="text-xs text-amber-300">
                Below the {currency(minimumPayoutThreshold)} minimum payout — it will be recorded anyway.
              </p>
            ) : null}
            {total <= 0 ? <p className="text-xs text-zinc-500">Nothing is owed right now.</p> : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-zinc-400">
              Paid via
              <select
                name="paidVia"
                value={paidVia}
                onChange={(event) => changeChannel(event.target.value)}
                disabled={busy}
                className="vl-input mt-1 w-full px-3 py-2 text-sm"
              >
                <option value="">Choose how you sent it</option>
                {PAYOUT_CHANNELS.map((channel) => (
                  <option key={channel} value={channel}>{PAYOUT_CHANNEL_LABELS[channel]}</option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-zinc-400">
              Sent to
              <input
                type="text"
                name="paidTo"
                value={paidTo}
                onChange={(event) => setPaidTo(event.target.value)}
                placeholder={paidVia ? HANDLE_PLACEHOLDER[paidVia] : "Handle, phone or email"}
                disabled={busy}
                maxLength={200}
                className="vl-input mt-1 w-full px-3 py-2 text-sm"
              />
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-zinc-400">
              Transaction reference <span className="text-zinc-600">(optional)</span>
              <input
                type="text"
                name="transactionReference"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="Confirmation or transaction ID"
                disabled={busy}
                maxLength={200}
                className="vl-input mt-1 w-full px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-xs text-zinc-400">
              Note <span className="text-zinc-600">(optional)</span>
              <input
                type="text"
                name="note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Anything worth remembering"
                disabled={busy}
                maxLength={300}
                className="vl-input mt-1 w-full px-3 py-2 text-sm"
              />
            </label>
          </div>

          {approved ? (
            <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-cyan-400/30 bg-cyan-500/5 p-3 text-sm text-zinc-200">
              <input
                type="checkbox"
                name="confirmedTransferred"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                disabled={busy}
                className="mt-0.5"
              />
              <span>
                I have already sent {currency(total)} to {target.name}.
                <span className="mt-0.5 block text-xs text-zinc-500">This records the payment and emails them a confirmation. It does not move any money.</span>
              </span>
            </label>
          ) : (
            <p className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-3 text-sm text-amber-200">
              {target.name}&apos;s status is <span className="font-semibold">{statusLabel}</span>. Approve them first — a payout cannot be recorded for an ambassador who is not approved.
            </p>
          )}

          {error ? <p className="text-sm text-rose-300">{error}</p> : null}

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={busy} className="vl-btn-secondary px-4 py-2 text-sm">Cancel</button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="vl-focus-ring rounded-lg bg-gradient-to-r from-cyan-300 via-blue-200 to-indigo-200 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-50"
            >
              {busy ? "Recording…" : `Record ${currency(total)} payout`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// A self-contained button for server-rendered pages (the payout queue, the
// ambassador profile): opens the dialog, and re-fetches the page once a payout
// has been written so every figure on it moves together.
export function AdminRecordPayoutButton({
  target,
  minimumPayoutThreshold,
  className,
  children,
}: {
  target: RecordPayoutTarget;
  minimumPayoutThreshold: number;
  className?: string;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [recorded, setRecorded] = useState<string | null>(null);
  const payable = target.amountOwed > 0;

  return (
    <>
      <button
        type="button"
        disabled={!payable}
        onClick={() => setOpen(true)}
        className={className ?? "rounded border border-cyan-400/35 bg-cyan-500/10 px-3 py-1.5 text-xs font-semibold text-cyan-100 disabled:opacity-50"}
      >
        {children ?? "Record payout"}
      </button>
      {recorded ? <span className="ml-2 text-xs text-emerald-200">{recorded}</span> : null}
      {open ? (
        <AdminRecordPayoutDialog
          target={target}
          minimumPayoutThreshold={minimumPayoutThreshold}
          onClose={() => setOpen(false)}
          onRecorded={(payout) => {
            setOpen(false);
            setRecorded(`Recorded ${currency(payout.amount)}`);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
