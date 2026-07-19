"use client";

import { FormEvent, useState } from "react";

const SUPPORT_EMAIL = "support@vantalabsresearch.com";
const SUPPORT_SUBJECT = "Vanta Labs Customer Support";

function createSupportMailto() {
  const subject = encodeURIComponent(SUPPORT_SUBJECT);
  return `mailto:${SUPPORT_EMAIL}?subject=${subject}`;
}

export default function ContactPage() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [subject, setSubject] = useState(SUPPORT_SUBJECT);
  const [message, setMessage] = useState("");
  const [company, setCompany] = useState("");
  const [startedAt, setStartedAt] = useState(() => String(Date.now()));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [statusTone, setStatusTone] = useState<"success" | "error" | null>(null);

  const mailtoHref = createSupportMailto();

  const resetForm = () => {
    setFirstName("");
    setLastName("");
    setEmail("");
    setOrderNumber("");
    setSubject(SUPPORT_SUBJECT);
    setMessage("");
    setCompany("");
    setStartedAt(String(Date.now()));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (isSubmitting) {
      return;
    }

    setStatus(null);
    setStatusTone(null);

    const elapsed = Number(startedAt) ? Date.now() - Number(startedAt) : 0;
    if (company.trim()) {
      setStatusTone("error");
      setStatus("Submission rejected.");
      return;
    }

    if (elapsed < 3000) {
      setStatusTone("error");
      setStatus("Please take a moment before submitting again.");
      return;
    }

    if (!firstName.trim() || !lastName.trim() || !email.trim() || !subject.trim() || !message.trim()) {
      setStatusTone("error");
      setStatus("Please complete all required fields.");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName,
          lastName,
          email,
          orderNumber,
          subject,
          message,
          company,
          startedAt,
        }),
      });

      const json = (await response.json()) as { success?: boolean; error?: string };

      if (!response.ok || !json.success) {
        throw new Error(json.error ?? "Unable to send message.");
      }

      setStatusTone("success");
      setStatus("Thanks. Your message has been sent successfully.");
      resetForm();
    } catch (error) {
      setStatusTone("error");
      setStatus(error instanceof Error ? error.message : "Unable to send message right now.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-12 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[0.92fr_1.08fr]">
        <section className="vl-panel rounded-[2rem] border border-white/15 p-6 sm:p-8">
          <p className="text-[11px] uppercase tracking-[0.28em] text-zinc-500">Support</p>
          <h1 className="mt-3 text-3xl font-semibold text-white sm:text-4xl">Contact Vanta Labs</h1>
          <p className="mt-4 text-sm leading-7 text-zinc-300">
            Have questions regarding your order, products, shipping, or general inquiries? Our team typically responds within one business day.
          </p>

          <div className="mt-8 space-y-5 rounded-[1.5rem] border border-white/10 bg-white/5 p-5">
            <div>
              <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Email</p>
              <a href={mailtoHref} className="mt-2 inline-block text-base font-medium text-white transition hover:text-zinc-300">
                {SUPPORT_EMAIL}
              </a>
              <p className="mt-1 text-sm text-zinc-400">Subject defaults to {SUPPORT_SUBJECT}.</p>
            </div>

            <div>
              <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Business Hours</p>
              <p className="mt-2 text-sm text-zinc-200">Monday–Friday</p>
              <p className="text-sm text-zinc-200">9:00 AM – 5:00 PM EST</p>
            </div>
          </div>
        </section>

        <section className="vl-panel rounded-[2rem] border border-white/15 p-6 sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.28em] text-zinc-500">Contact Form</p>
              <h2 className="mt-3 text-2xl font-semibold text-white">Send a message</h2>
            </div>
            <a href={mailtoHref} className="vl-btn-secondary vl-focus-ring whitespace-nowrap px-4 py-2 text-xs sm:text-sm">
              Email support
            </a>
          </div>

          <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm text-zinc-300">
                <span className="mb-2 block">First Name</span>
                <input
                  type="text"
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  className="vl-input w-full px-4 py-3"
                  autoComplete="given-name"
                  required
                />
              </label>

              <label className="block text-sm text-zinc-300">
                <span className="mb-2 block">Last Name</span>
                <input
                  type="text"
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  className="vl-input w-full px-4 py-3"
                  autoComplete="family-name"
                  required
                />
              </label>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm text-zinc-300">
                <span className="mb-2 block">Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="vl-input w-full px-4 py-3"
                  autoComplete="email"
                  required
                />
              </label>

              <label className="block text-sm text-zinc-300">
                <span className="mb-2 block">Order Number</span>
                <input
                  type="text"
                  value={orderNumber}
                  onChange={(event) => setOrderNumber(event.target.value)}
                  className="vl-input w-full px-4 py-3"
                  placeholder="Optional"
                  autoComplete="off"
                />
              </label>
            </div>

            <label className="block text-sm text-zinc-300">
              <span className="mb-2 block">Subject</span>
              <input
                type="text"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                className="vl-input w-full px-4 py-3"
                required
              />
            </label>

            <label className="block text-sm text-zinc-300">
              <span className="mb-2 block">Message</span>
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                className="vl-input min-h-40 w-full px-4 py-3"
                required
              />
            </label>

            <div className="sr-only" aria-hidden="true">
              <label>
                Company
                <input type="text" value={company} onChange={(event) => setCompany(event.target.value)} tabIndex={-1} autoComplete="off" />
              </label>
              <input type="hidden" name="startedAt" value={startedAt} readOnly />
            </div>

            {status ? (
              <p
                className={`rounded-xl border px-4 py-3 text-sm ${
                  statusTone === "success"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-200"
                }`}
                aria-live="polite"
              >
                {status}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={isSubmitting}
              className="vl-btn-primary vl-focus-ring w-full px-5 py-3 text-sm disabled:opacity-60"
            >
              {isSubmitting ? "Sending..." : "Submit"}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}