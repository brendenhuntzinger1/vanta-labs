"use client";

import Image from "next/image";
import { useState } from "react";
import { formatCartCurrency } from "@/components/cart-context";
import type { PaymentMethodConfig } from "@/lib/payment-methods";

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          // Clipboard unavailable — the value is still visible to copy manually.
        }
      }}
      className="vl-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white transition hover:border-white/50"
    >
      {copied ? "✓ Copied" : label}
    </button>
  );
}

function DetailRow({ label, value, copyLabel }: { label: string; value: string; copyLabel?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/10 py-2.5 last:border-b-0">
      <span className="shrink-0 text-xs uppercase tracking-[0.12em] text-white/45">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 break-all text-right text-sm font-medium text-white">{value}</span>
        {copyLabel ? <CopyButton value={value} label={copyLabel} /> : null}
      </span>
    </div>
  );
}

export function ManualPaymentInstructions({
  method,
  orderId,
  orderNumber,
  amountDue,
  onSubmitted,
}: {
  method: PaymentMethodConfig;
  orderId: string;
  orderNumber: string;
  amountDue: number;
  onSubmitted?: () => void;
}) {
  const [transactionId, setTransactionId] = useState("");
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const referenceLabel = method.referenceLabel ?? "Transaction ID";

  const handleSubmit = async () => {
    if (!transactionId.trim()) {
      setMessage(`Please enter your ${referenceLabel} to confirm your payment.`);
      return;
    }
    setSubmitting(true);
    setMessage(null);

    try {
      const formData = new FormData();
      formData.append("orderId", orderId);
      formData.append("transactionId", transactionId.trim());
      if (screenshot) {
        formData.append("screenshot", screenshot);
      }

      const response = await fetch("/api/checkout/submit-payment", { method: "POST", body: formData });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error ?? "Unable to submit your payment.");
      }
      setSubmitted(true);
      setMessage(data.uploadWarning ?? null);
      onSubmitted?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to submit your payment.");
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="vl2-fade-in rounded-2xl border border-emerald-400/30 bg-emerald-400/5 p-6 text-center sm:p-8">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-emerald-400/40 bg-emerald-400/10 text-2xl">✓</div>
        <h3 className="vl2-serif mt-4 text-2xl text-white">Payment submitted</h3>
        <p className="mt-2 text-sm text-white/60">
          Thanks! We&apos;ve received your payment details for order{" "}
          <span className="font-semibold text-white">{orderNumber}</span> and are verifying it now. You&apos;ll get a
          confirmation email as soon as it&apos;s approved.
        </p>
        {message ? <p className="mt-3 text-xs text-amber-300">{message}</p> : null}
      </div>
    );
  }

  return (
    <div className="vl2-fade-in space-y-6">
      {/* Order number — large, bold, copyable */}
      <div className="rounded-2xl border border-[color:var(--accent-gold-soft)] bg-[color:var(--accent-gold-soft)] p-5 text-center">
        <p className="vl2-eyebrow text-[color:var(--accent-gold)]">Your Order Number</p>
        <p className="vl2-serif mt-2 text-3xl font-semibold tracking-wide text-white sm:text-4xl">{orderNumber}</p>
        <div className="mt-3 flex justify-center">
          <CopyButton value={orderNumber} label="Copy Order Number" />
        </div>
        <p className="mt-3 text-xs text-white/60">Please include your Order Number in the payment note.</p>
      </div>

      <div className="grid gap-6 sm:grid-cols-[0.9fr_1.1fr]">
        {/* QR + amount */}
        <div className="flex flex-col items-center rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <span className="text-3xl" aria-hidden>{method.icon}</span>
          <p className="mt-2 text-sm font-semibold text-white">Pay with {method.label}</p>
          {method.qrImageUrl ? (
            <div className="mt-4 overflow-hidden rounded-xl bg-white p-2">
              <Image src={method.qrImageUrl} alt={`${method.label} QR code`} width={200} height={200} className="h-44 w-44 object-contain" />
            </div>
          ) : null}
          <p className="mt-4 text-xs uppercase tracking-[0.12em] text-white/45">Amount Due</p>
          <p className="text-2xl font-semibold text-white">{formatCartCurrency(amountDue)}</p>
        </div>

        {/* Account details + instructions */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <div className="space-y-0">
            {method.handle ? <DetailRow label={method.label} value={method.handle} copyLabel="Copy" /> : null}
            {method.businessName ? <DetailRow label="Business Name" value={method.businessName} copyLabel="Copy" /> : null}
            {method.email ? <DetailRow label="Email" value={method.email} copyLabel="Copy" /> : null}
            {method.phone ? <DetailRow label="Phone" value={method.phone} copyLabel="Copy" /> : null}
            <DetailRow label="Amount" value={formatCartCurrency(amountDue)} copyLabel="Copy" />
          </div>

          {method.instructions.length > 0 ? (
            <ol className="mt-4 space-y-2 text-sm text-white/65">
              {method.instructions.map((step, index) => (
                <li key={index} className="flex gap-2.5">
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-white/20 text-[11px] text-white/70">{index + 1}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          ) : null}

          {method.memoNote ? (
            <p className="mt-4 rounded-lg border border-amber-300/25 bg-amber-300/5 px-3 py-2 text-xs leading-5 text-amber-200/90">
              ⚠ {method.memoNote}
            </p>
          ) : null}
        </div>
      </div>

      {/* Confirmation form */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <p className="vl2-eyebrow">Confirm Your Payment</p>
        <label className="mt-3 block text-sm text-white/60">
          <span className="mb-2 block">{referenceLabel} *</span>
          <input
            value={transactionId}
            onChange={(e) => setTransactionId(e.target.value)}
            placeholder={`Enter your ${referenceLabel}`}
            className="w-full rounded-lg border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50"
          />
        </label>

        <label className="mt-4 block text-sm text-white/60">
          <span className="mb-2 block">Payment screenshot (optional)</span>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setScreenshot(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-white/60 file:mr-3 file:rounded-lg file:border file:border-white/20 file:bg-white/[0.05] file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:border-white/40"
          />
        </label>

        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="vl2-btn-primary vl-focus-ring mt-5 w-full px-5 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Submitting…" : "I've Sent Payment"}
        </button>

        {message ? <p className="mt-3 text-sm text-amber-300">{message}</p> : null}
      </div>
    </div>
  );
}
