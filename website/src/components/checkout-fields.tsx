"use client";

import { useId } from "react";

// -------------------------------------------------------------------------
// Checkout form primitives — floating-label fields tuned for iPhone.
//
// Every input is 16px minimum: iOS Safari auto-zooms the viewport on focus for
// anything smaller, which yanks the layout sideways mid-checkout. Labels float
// via the `placeholder-shown` trick (pure CSS, no JS, no re-render), so there
// is zero layout shift when a field fills.
// -------------------------------------------------------------------------

const FIELD_SHELL =
  "peer w-full rounded-xl border bg-black/30 px-4 pb-2 pt-6 text-[16px] leading-tight text-white outline-none transition duration-200 placeholder:text-transparent";
const FIELD_IDLE = "border-white/[0.10] focus:border-white/40 focus:bg-black/50 focus:shadow-[0_0_0_4px_rgba(255,255,255,0.05)]";
const FIELD_ERROR = "border-rose-400/50 focus:border-rose-400/70 focus:shadow-[0_0_0_4px_rgba(251,113,133,0.10)]";

// Floating label: sits mid-height when empty, shrinks to the top once the field
// has content or focus.
const LABEL_BASE =
  "pointer-events-none absolute left-4 z-10 origin-left text-white/40 transition-all duration-200 ease-out motion-reduce:transition-none";
const LABEL_FLOAT =
  "top-[1.15rem] text-[15px] peer-focus:top-[0.45rem] peer-focus:text-[11px] peer-focus:tracking-wide peer-focus:text-white/55 peer-[:not(:placeholder-shown)]:top-[0.45rem] peer-[:not(:placeholder-shown)]:text-[11px] peer-[:not(:placeholder-shown)]:tracking-wide";

function ErrorText({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="mt-1.5 flex items-center gap-1.5 pl-1 text-xs text-rose-300 animate-[vl-field-error_0.32s_ease-out]">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5 flex-shrink-0" aria-hidden>
        <circle cx="12" cy="12" r="9" /><path d="M12 8v4.5M12 16h.01" />
      </svg>
      {children}
    </p>
  );
}

export function TextField({
  label,
  value,
  onChange,
  error,
  type = "text",
  inputMode,
  autoComplete,
  autoCapitalize,
  readOnly,
  placeholderHint,
  className = "",
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  type?: string;
  inputMode?: "text" | "email" | "tel" | "numeric" | "decimal" | "search" | "url";
  autoComplete?: string;
  autoCapitalize?: string;
  readOnly?: boolean;
  placeholderHint?: string;
  className?: string;
  maxLength?: number;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className={className}>
      <div className="relative">
        <input
          id={id}
          type={type}
          inputMode={inputMode}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          autoCapitalize={autoCapitalize}
          readOnly={readOnly}
          maxLength={maxLength}
          // A non-empty placeholder is what makes :placeholder-shown work; a
          // single space keeps it invisible while the label is floated down.
          placeholder={placeholderHint ?? " "}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={`${FIELD_SHELL} ${error ? FIELD_ERROR : FIELD_IDLE} ${readOnly ? "cursor-not-allowed text-white/55" : ""}`}
        />
        <label htmlFor={id} className={`${LABEL_BASE} ${LABEL_FLOAT}`}>
          {label}
        </label>
      </div>
      {error ? <ErrorText id={errorId}>{error}</ErrorText> : null}
    </div>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  error,
  autoComplete,
  children,
  className = "",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  autoComplete?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className={className}>
      <div className="relative">
        {/* A <select> always has a value, so its label is permanently in the
            floated position rather than animating. */}
        <label htmlFor={id} className="pointer-events-none absolute left-4 top-[0.45rem] z-10 text-[11px] tracking-wide text-white/55">
          {label}
        </label>
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={`w-full appearance-none rounded-xl border bg-black/30 px-4 pb-2 pt-6 text-[16px] leading-tight text-white outline-none transition duration-200 ${error ? FIELD_ERROR : FIELD_IDLE}`}
        >
          {children}
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
      {error ? <ErrorText id={errorId}>{error}</ErrorText> : null}
    </div>
  );
}

// Smooth, CLS-free expand/collapse (grid-rows 0fr→1fr). Shared with the cart.
//
// `inert` when closed is load-bearing, not decoration: `overflow: hidden` clips
// content visually but leaves it in the tab order and the accessibility tree.
// Without this, a keyboard or screen-reader user tabs into invisible collapsed
// fields (e.g. the billing address while "same as shipping" is ticked).
export function Collapse({ open, children, className = "" }: { open: boolean; children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"} ${className}`}
    >
      <div className="overflow-hidden" inert={!open}>{children}</div>
    </div>
  );
}

// Section wrapper: a numbered, titled group so the shopper always knows where
// they are in the flow without a fake multi-page stepper.
export function CheckoutSection({
  step,
  title,
  subtitle,
  children,
  innerRef,
}: {
  step: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  innerRef?: React.Ref<HTMLElement>;
}) {
  return (
    <section ref={innerRef} className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5 sm:p-6">
      <div className="flex items-baseline gap-3">
        <span className="text-[11px] font-semibold tabular-nums text-[color:var(--accent-gold)]/70">{step}</span>
        <div>
          <h2 className="text-base font-semibold tracking-tight text-white sm:text-lg">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs text-white/40">{subtitle}</p> : null}
        </div>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}
