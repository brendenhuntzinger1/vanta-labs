"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The wholesale enquiry form.
 *
 * Every claim on the page above it is general on purpose; this is where the
 * specifics get collected instead. Asking for volume and products rather than
 * publishing a bulk price sheet is what lets a quote follow the order rather
 * than the order following a published number.
 *
 * `startedAt` is stamped on mount and sent with the submission: the server
 * rejects anything returned in under three seconds, which no human fills in and
 * most bots do. `website` is the honeypot — hidden from sight and from screen
 * readers, so only a script ever fills it.
 */

const VOLUMES = [
  "Not sure yet",
  "Under 25 units / month",
  "25–100 units / month",
  "100–500 units / month",
  "500+ units / month",
];

type Status = { kind: "idle" | "sending" } | { kind: "sent" } | { kind: "error"; message: string };

const field =
  "w-full rounded-xl border border-white/[0.10] bg-[#0f0f0f] px-4 py-3 text-sm text-white " +
  "placeholder:text-white/25 transition outline-none " +
  "focus:border-[color:var(--accent-gold)]/50 focus:ring-2 focus:ring-[color:var(--accent-gold)]/20";

function Label({ htmlFor, children, required }: { htmlFor: string; children: React.ReactNode; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="mb-2 block text-[11px] uppercase tracking-[0.16em] text-white/45">
      {children}
      {required ? <span className="ml-1 text-[color:var(--accent-gold)]/70">*</span> : null}
    </label>
  );
}

export function WholesaleForm() {
  // Stamped on mount, not during render: reading the clock while rendering is
  // impure and would also record a time from the server pass rather than the
  // moment this visitor actually saw the form.
  const startedAt = useRef(0);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setStatus({ kind: "sending" });

    try {
      const response = await fetch("/api/wholesale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: data.get("firstName"),
          lastName: data.get("lastName"),
          email: data.get("email"),
          phone: data.get("phone"),
          organization: data.get("organization"),
          volume: data.get("volume"),
          products: data.get("products"),
          message: data.get("message"),
          website: data.get("website"),
          startedAt: String(startedAt.current),
        }),
      });
      const body = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !body.success) {
        setStatus({ kind: "error", message: body.error ?? "We couldn't send that. Please try again." });
        return;
      }
      form.reset();
      setStatus({ kind: "sent" });
    } catch {
      setStatus({ kind: "error", message: "We couldn't reach the server. Please try again." });
    }
  }

  if (status.kind === "sent") {
    return (
      <div
        role="status"
        className="rounded-2xl border border-[color:var(--accent-gold)]/25 bg-[color:var(--accent-gold)]/[0.05] px-6 py-10 text-center"
      >
        <p className="vl2-eyebrow text-[color:var(--accent-gold)]">Request received</p>
        <h3 className="vl2-serif mt-3 text-2xl text-white">Thanks — we have your inquiry</h3>
        <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-white/55">
          We&rsquo;ve sent a confirmation to your email and will review the details you submitted.
        </p>
        <button
          type="button"
          onClick={() => {
            startedAt.current = Date.now();
            setStatus({ kind: "idle" });
          }}
          className="vl-focus-ring mt-6 rounded-xl border border-white/15 px-5 py-2.5 text-xs uppercase tracking-[0.16em] text-white/70 transition hover:border-white/30 hover:text-white"
        >
          Submit another
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate={false} className="space-y-5">
      {/* Honeypot: hidden from sight AND from assistive technology, so no real
          user can be tricked into filling it. */}
      <div aria-hidden="true" className="hidden">
        <label htmlFor="wholesale-website">Website</label>
        <input id="wholesale-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <Label htmlFor="wholesale-first" required>First name</Label>
          <input id="wholesale-first" name="firstName" required maxLength={100} autoComplete="given-name" className={field} />
        </div>
        <div>
          <Label htmlFor="wholesale-last" required>Last name</Label>
          <input id="wholesale-last" name="lastName" required maxLength={100} autoComplete="family-name" className={field} />
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <Label htmlFor="wholesale-email" required>Email</Label>
          <input id="wholesale-email" name="email" type="email" required maxLength={200} autoComplete="email" className={field} />
        </div>
        <div>
          <Label htmlFor="wholesale-phone">Phone</Label>
          <input id="wholesale-phone" name="phone" type="tel" maxLength={200} autoComplete="tel" className={field} />
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <Label htmlFor="wholesale-org">Company / organisation</Label>
          <input id="wholesale-org" name="organization" maxLength={200} autoComplete="organization" className={field} />
        </div>
        <div>
          <Label htmlFor="wholesale-volume">Estimated order volume</Label>
          <select id="wholesale-volume" name="volume" defaultValue="" className={field}>
            <option value="">Select an option</option>
            {VOLUMES.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <Label htmlFor="wholesale-products">Products of interest</Label>
        <input
          id="wholesale-products"
          name="products"
          maxLength={200}
          placeholder="e.g. BPC-157, TB-500"
          className={field}
        />
      </div>

      <div>
        <Label htmlFor="wholesale-message" required>What are you looking for?</Label>
        <textarea
          id="wholesale-message"
          name="message"
          required
          rows={5}
          maxLength={5000}
          placeholder="Quantities, cadence, and anything else that would help us understand your requirements."
          className={`${field} resize-y`}
        />
      </div>

      {status.kind === "error" ? (
        <p role="alert" className="rounded-xl border border-red-400/30 bg-red-400/[0.07] px-4 py-3 text-sm text-red-200">
          {status.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={status.kind === "sending"}
        className="vl2-btn-primary vl-focus-ring flex w-full items-center justify-center px-6 py-4 text-xs uppercase tracking-[0.16em] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status.kind === "sending" ? "Sending…" : "Request wholesale pricing"}
      </button>

      <p className="text-center text-[11px] leading-5 text-white/30">
        Submitting sends your details to the Vanta Labs team. Pricing is issued after review — nothing is ordered or
        charged here.
      </p>
    </form>
  );
}
