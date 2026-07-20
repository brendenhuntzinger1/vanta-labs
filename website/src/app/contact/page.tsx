"use client";

import { FormEvent, useState } from "react";
import { SiteHeaderV2 } from "@/components/site-header-v2";

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
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />
      <main className="px-6 pb-20 pt-32 lg:px-12">
      <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[0.92fr_1.08fr]">
        <section className="border border-white/10 p-6 sm:p-8">
          <p className="vl2-eyebrow">Support</p>
          <h1 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">Contact Vanta Labs</h1>
          <p className="mt-4 text-sm leading-7 text-white/60">
            Have questions regarding your order, products, shipping, or general inquiries? Our team typically responds within one business day.
          </p>

          <div className="mt-8 space-y-5 border border-white/10 p-5">
            <div>
              <p className="vl2-eyebrow">Email</p>
              <a href={mailtoHref} className="mt-2 inline-block text-base text-white transition hover:text-white/70">
                {SUPPORT_EMAIL}
              </a>
              <p className="mt-1 text-sm text-white/45">Subject defaults to {SUPPORT_SUBJECT}.</p>
            </div>

            <div>
              <p className="vl2-eyebrow">Business Hours</p>
              <p className="mt-2 text-sm text-white/75">Monday–Friday</p>
              <p className="text-sm text-white/75">9:00 AM – 5:00 PM EST</p>
            </div>
          </div>
        </section>

        <section className="border border-white/10 p-6 sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="vl2-eyebrow">Contact Form</p>
              <h2 className="vl2-serif mt-3 text-2xl text-white">Send a message</h2>
            </div>
            <a href={mailtoHref} className="vl2-btn-secondary vl-focus-ring whitespace-nowrap px-4 py-2 text-xs sm:text-sm">
              Email support
            </a>
          </div>

          <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm text-white/60">
                <span className="mb-2 block">First Name</span>
                <input
                  type="text"
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50"
                  autoComplete="given-name"
                  required
                />
              </label>

              <label className="block text-sm text-white/60">
                <span className="mb-2 block">Last Name</span>
                <input
                  type="text"
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50"
                  autoComplete="family-name"
                  required
                />
              </label>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm text-white/60">
                <span className="mb-2 block">Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50"
                  autoComplete="email"
                  required
                />
              </label>

              <label className="block text-sm text-white/60">
                <span className="mb-2 block">Order Number</span>
                <input
                  type="text"
                  value={orderNumber}
                  onChange={(event) => setOrderNumber(event.target.value)}
                  className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50"
                  placeholder="Optional"
                  autoComplete="off"
                />
              </label>
            </div>

            <label className="block text-sm text-white/60">
              <span className="mb-2 block">Subject</span>
              <input
                type="text"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50"
                required
              />
            </label>

            <label className="block text-sm text-white/60">
              <span className="mb-2 block">Message</span>
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                className="min-h-40 w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50"
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
                className={`border px-4 py-3 text-sm ${
                  statusTone === "success"
                    ? "border-emerald-500/30 text-emerald-200"
                    : "border-rose-500/30 text-rose-200"
                }`}
                aria-live="polite"
              >
                {status}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={isSubmitting}
              className="vl2-btn-primary vl-focus-ring w-full px-5 py-3 text-sm disabled:opacity-60"
            >
              {isSubmitting ? "Sending..." : "Submit"}
            </button>
          </form>
        </section>
      </div>
      </main>
    </div>
  );
}