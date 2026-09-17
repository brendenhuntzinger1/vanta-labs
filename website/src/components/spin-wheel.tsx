"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type WheelSlice = {
  id: string;
  wedgeLabel: string;
  label: string;
  minSubtotalCents: number;
  condition: string;
};

export type WheelPrizeResult = {
  sliceIndex: number;
  label: string;
  condition: string;
  minSubtotalCents: number;
  /** The SAVED instant the prize dies. Never a duration. */
  expiresAt: string;
  alreadySpun: boolean;
};

type Props = {
  slices: WheelSlice[];
  terms: readonly string[];
  token: string;
  /** A prize this customer already won. Present means the wheel does not spin. */
  initialResult: WheelPrizeResult | null;
};

const WEDGE_FILLS = [
  "#1e3a5f", "#c2410c", "#0f766e", "#7c2d12",
  "#1e40af", "#b45309", "#115e59", "#9a3412",
  "#1d4ed8", "#ea580c", "#0d9488", "#a16207",
  "#2563eb", "#d97706", "#14b8a6", "#854d0e",
];

/**
 * THE COUNTDOWN READS THE SAVED EXPIRY AND NOTHING ELSE.
 *
 * The tempting version starts a 72-hour timer when the component mounts. That
 * is a different, longer promise on every refresh — the customer can hold a
 * prize with eleven minutes left and be shown three days, and the checkout will
 * refuse a token the page says is live. The instant comes from the offer row,
 * so a refresh re-reads the same moment and the number only ever goes down.
 */
function useCountdown(expiresAt: string | null): { text: string; expired: boolean } {
  const target = useMemo(() => (expiresAt ? new Date(expiresAt).getTime() : null), [expiresAt]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!target) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [target]);

  if (!target || !Number.isFinite(target)) return { text: "", expired: false };
  const remaining = target - now;
  if (remaining <= 0) return { text: "Expired", expired: true };

  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return {
    text: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
    expired: false,
  };
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export default function SpinWheel({ slices, terms, token, initialResult }: Props) {
  const count = slices.length;
  const wedgeAngle = 360 / count;

  const [result, setResult] = useState<WheelPrizeResult | null>(initialResult);
  const [spinning, setSpinning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Revealed only after the animation settles, so the prize is not spoiled. */
  const [revealed, setRevealed] = useState(Boolean(initialResult));
  const [rotation, setRotation] = useState(() =>
    initialResult ? restingRotation(initialResult.sliceIndex, wedgeAngle) : 0,
  );

  const countdown = useCountdown(result?.expiresAt ?? null);
  /** Guards the double-click: a second press while one is in flight does nothing. */
  const inFlight = useRef(false);

  const spin = useCallback(async () => {
    if (inFlight.current || spinning || result) return;
    inFlight.current = true;
    setSpinning(true);
    setError(null);

    try {
      const response = await fetch("/api/spin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = await response.json();

      if (!response.ok || !body?.success) {
        setError(String(body?.error ?? "Something went wrong. Please try again."));
        setSpinning(false);
        inFlight.current = false;
        return;
      }

      const won: WheelPrizeResult = {
        sliceIndex: Number(body.sliceIndex),
        label: String(body.prize.label),
        condition: String(body.prize.condition),
        minSubtotalCents: Number(body.prize.minSubtotalCents),
        expiresAt: String(body.expiresAt),
        alreadySpun: Boolean(body.alreadySpun),
      };
      setResult(won);

      // Five full turns then settle on the winning wedge. The server decided
      // which wedge before this request returned; the animation only reports it.
      setRotation(360 * 5 + restingRotation(won.sliceIndex, wedgeAngle));
      window.setTimeout(() => {
        setRevealed(true);
        setSpinning(false);
      }, 4_200);
    } catch {
      setError("We couldn't reach the server. Please try again.");
      setSpinning(false);
      inFlight.current = false;
    }
  }, [spinning, result, token, wedgeAngle]);

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-8">
      <header className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Spin to win</h1>
        <p className="mt-2 text-sm text-neutral-500">
          One spin, {count} prizes, and every spin wins.
        </p>
      </header>

      <div className="relative mx-auto mt-8 aspect-square w-full max-w-[340px]">
        {/* The pointer. Sits at twelve o'clock; the wheel turns under it. */}
        <div
          aria-hidden
          className="absolute left-1/2 top-[-6px] z-10 h-0 w-0 -translate-x-1/2"
          style={{
            borderLeft: "12px solid transparent",
            borderRight: "12px solid transparent",
            borderTop: "22px solid #dc2626",
          }}
        />
        <svg
          viewBox="0 0 200 200"
          className="h-full w-full drop-shadow"
          style={{
            transform: `rotate(${rotation}deg)`,
            // Long, heavily eased, so it reads as a wheel slowing down rather
            // than a number changing.
            transition: spinning ? "transform 4s cubic-bezier(0.17, 0.67, 0.12, 0.99)" : "none",
          }}
        >
          <circle cx="100" cy="100" r="99" fill="#0a0a0a" />
          {slices.map((slice, index) => (
            <g key={slice.id}>
              <path d={wedgePath(index, wedgeAngle)} fill={WEDGE_FILLS[index % WEDGE_FILLS.length]} stroke="#0a0a0a" strokeWidth="0.6" />
              {/* RADIAL TEXT. Sixteen wedges is 22.5 degrees each, which at
                  390px is far too narrow for horizontal words — the labels run
                  outward from the hub instead, the way a real prize wheel does. */}
              <text
                x="62"
                y="100"
                fill="#ffffff"
                fontSize="6.4"
                fontWeight="700"
                dominantBaseline="middle"
                textAnchor="middle"
                transform={`rotate(${index * wedgeAngle + wedgeAngle / 2} 100 100)`}
                style={{ letterSpacing: "0.02em" }}
              >
                {slice.wedgeLabel}
              </text>
            </g>
          ))}
          <circle cx="100" cy="100" r="17" fill="#111827" stroke="#374151" strokeWidth="1.5" />
        </svg>
      </div>

      <div className="mt-6 text-center">
        {!result && (
          <button
            type="button"
            onClick={spin}
            disabled={spinning}
            className="w-full rounded-lg bg-red-600 px-6 py-4 text-base font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-12"
          >
            {spinning ? "Spinning…" : "Spin the wheel"}
          </button>
        )}

        {error && (
          <p role="alert" className="mt-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}

        {result && revealed && (
          <div className="mt-2 rounded-xl border border-neutral-200 bg-white p-5 text-left shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {result.alreadySpun ? "You already span — here's your prize" : "You won"}
            </p>
            <p className="mt-1 text-xl font-semibold">{result.label}</p>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">{result.condition}</p>

            <div className="mt-4 flex items-baseline justify-between border-t border-neutral-200 pt-4 dark:border-neutral-800">
              <span className="text-sm text-neutral-500">
                {countdown.expired ? "This prize has expired" : "Expires in"}
              </span>
              {!countdown.expired && (
                <span className="font-mono text-lg font-semibold tabular-nums">{countdown.text}</span>
              )}
            </div>

            {!countdown.expired && (
              <a
                href="/catalog"
                className="mt-4 block rounded-lg bg-neutral-900 px-5 py-3 text-center text-sm font-semibold text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
              >
                Start shopping
              </a>
            )}
            <p className="mt-3 text-xs text-neutral-500">
              Your prize is saved to your account and applies automatically at checkout — on this device or any other.
            </p>
          </div>
        )}
      </div>

      {/* ---------------------------------------------------------------
          THE TERMS ARE ABOVE THE FOLD OF THE PRIZE LIST AND RENDER BEFORE
          ANYONE SPINS. They are not a footer link and not a modal behind
          the button: the odds, the minimums and the expiry are what make
          this an honest promotion rather than a slot machine, so they are
          on the page at the moment the decision is made.
          --------------------------------------------------------------- */}
      <section className="mt-10" aria-labelledby="spin-terms">
        <h2 id="spin-terms" className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Before you spin
        </h2>
        <ul className="mt-3 space-y-2 text-sm text-neutral-600 dark:text-neutral-400">
          {terms.map((term) => (
            <li key={term} className="flex gap-2">
              <span aria-hidden className="text-neutral-400">•</span>
              <span>{term}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8" aria-labelledby="spin-prizes">
        <h2 id="spin-prizes" className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Every prize and its odds
        </h2>
        <div className="mt-3 overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Prize</th>
                <th scope="col" className="px-3 py-2 font-medium">Odds</th>
                <th scope="col" className="px-3 py-2 font-medium">Minimum order</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {slices.map((slice) => (
                <tr key={slice.id}>
                  <td className="px-3 py-2">
                    <span className="font-medium">{slice.label}</span>
                    <span className="mt-0.5 block text-xs text-neutral-500">{slice.condition}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-neutral-600 dark:text-neutral-400">
                    1 in {count}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-neutral-600 dark:text-neutral-400">
                    {slice.minSubtotalCents === 0 ? "None" : money(slice.minSubtotalCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-neutral-500">
          Research use only. Not for human or veterinary consumption. Prizes are redeemed through
          normal checkout and are subject to the same age and research-use requirements as any order.
        </p>
      </section>
    </div>
  );
}

/**
 * How far to turn so wedge `index` finishes under the pointer at twelve
 * o'clock. Wedges are laid out clockwise from the top, so bringing one back to
 * the top is the negative of its own centre angle.
 */
function restingRotation(index: number, wedgeAngle: number): number {
  const centre = index * wedgeAngle + wedgeAngle / 2;
  return -centre;
}

/** One wedge as an SVG path, drawn clockwise from twelve o'clock. */
function wedgePath(index: number, wedgeAngle: number): string {
  const start = index * wedgeAngle - 90;
  const end = start + wedgeAngle;
  const radius = 99;
  const toPoint = (degrees: number) => {
    const radians = (degrees * Math.PI) / 180;
    return `${(100 + radius * Math.cos(radians)).toFixed(3)} ${(100 + radius * Math.sin(radians)).toFixed(3)}`;
  };
  return `M 100 100 L ${toPoint(start)} A ${radius} ${radius} 0 0 1 ${toPoint(end)} Z`;
}
