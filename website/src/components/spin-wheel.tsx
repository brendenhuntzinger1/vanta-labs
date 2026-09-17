"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { formatMoneyFromCents as formatCents } from "@/lib/spin/disclosure";

export type WheelSlice = {
  id: string;
  wedgeLabel: string;
  label: string;
  minSubtotalCents: number;
  /** The soft condition — no figure. Shown beside every prize. */
  condition: string;
  /** The same condition WITH the figure, for the collapsed full terms. */
  exactCondition: string;
  /** Premium wedges are filled gold so the jackpot reads at a glance. */
  premium?: boolean;
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

/** One row of the prize list: a REWARD and its real odds, not one wedge. */
export type WheelPrizeOdds = {
  id: string;
  label: string;
  condition: string;
  exactCondition: string;
  /** How many wedges grant this reward. Two means twice the chance. */
  wedges: number;
  outOf: number;
  premium?: boolean;
};

type Props = {
  slices: WheelSlice[];
  prizes: WheelPrizeOdds[];
  terms: readonly string[];
  token: string;
  /** A prize this customer already won. Present means the wheel does not spin. */
  initialResult: WheelPrizeResult | null;
};

// THE PALETTE IS THE STORE'S, NOT A PIE CHART'S.
//
// The first version used sixteen unrelated blues, oranges and teals, which read
// as a spreadsheet chart dropped onto a black page. This is deep jewel tones
// rotating against charcoal, with GOLD RESERVED for the two best prizes — so
// the jackpot is visible before anyone reads a word, and the wheel belongs to
// the same brand as the rest of the store.
const INK = "#0b0b0c";
const GOLD = "#c7ae5e";
const GOLD_DEEP = "#8f7734";
const WEDGE_TONES = ["#16233d", "#1a1a1c", "#123630", "#221118", "#1a1a1c", "#13203a"];

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

export default function SpinWheel({ slices, prizes, terms, token, initialResult }: Props) {
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

      // Six full turns then settle on the winning wedge. The server decided
      // which wedge before this request returned; the animation only reports it.
      setRotation(360 * 6 + restingRotation(won.sliceIndex, wedgeAngle));
      window.setTimeout(() => {
        setRevealed(true);
        setSpinning(false);
      }, 4_600);
    } catch {
      setError("We couldn't reach the server. Please try again.");
      setSpinning(false);
      inFlight.current = false;
    }
  }, [spinning, result, token, wedgeAngle]);

  return (
    <div className="mx-auto w-full max-w-xl px-4 pb-16 pt-8">
      <header className="text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em]" style={{ color: GOLD }}>
          One spin · {prizes.length} prizes
        </p>
        <h1 className="mt-2 text-[32px] font-semibold leading-tight tracking-tight sm:text-4xl">
          Spin to win
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm" style={{ color: "var(--foreground-muted)" }}>
          {count} wedges, every spin wins, and your reward is claimed with your next order.
        </p>
      </header>

      <div className="relative mx-auto mt-8 w-full max-w-[340px]">
        {/* A soft gold bloom behind the wheel, so it sits on the page as a lit
            object rather than a flat disc pasted onto black. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 blur-2xl"
          style={{ background: `radial-gradient(circle at 50% 45%, ${GOLD}22, transparent 62%)` }}
        />

        <div className="relative aspect-square w-full">
          <svg viewBox="0 0 220 220" className="h-full w-full">
            <defs>
              <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#e6d29a" />
                <stop offset="38%" stopColor={GOLD} />
                <stop offset="62%" stopColor={GOLD_DEEP} />
                <stop offset="100%" stopColor="#e2cd93" />
              </linearGradient>
              <linearGradient id="goldWedge" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#e3cd92" />
                <stop offset="100%" stopColor={GOLD_DEEP} />
              </linearGradient>
              <radialGradient id="hub" cx="38%" cy="32%" r="78%">
                <stop offset="0%" stopColor="#3a3a3e" />
                <stop offset="100%" stopColor="#101012" />
              </radialGradient>
              {/* Depth across the face: lit at the top, falling away at the
                  bottom. One overlay for the whole wheel rather than per-wedge
                  shading, so it stays still while the wheel turns under it. */}
              <radialGradient id="faceShade" cx="50%" cy="34%" r="72%">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.1" />
                <stop offset="58%" stopColor="#000000" stopOpacity="0" />
                <stop offset="100%" stopColor="#000000" stopOpacity="0.42" />
              </radialGradient>
            </defs>

            {/* The turning part. Everything that must stay put — rim, pegs,
                hub, pointer — lives outside this group. */}
            <g
              style={{
                transform: `rotate(${rotation}deg)`,
                transformOrigin: "110px 110px",
                transition: spinning ? "transform 4.4s cubic-bezier(0.16, 0.72, 0.1, 1)" : "none",
              }}
            >
              <circle cx="110" cy="110" r="96" fill={INK} />
              {slices.map((slice, index) => (
                <path
                  key={slice.id}
                  d={wedgePath(index, wedgeAngle)}
                  fill={slice.premium ? "url(#goldWedge)" : WEDGE_TONES[index % WEDGE_TONES.length]}
                  stroke={INK}
                  strokeWidth="0.7"
                />
              ))}
              {slices.map((slice, index) => {
                const label = wedgeLabelGeometry(index, wedgeAngle);
                return (
                  <text
                    key={`${slice.id}-label`}
                    x={label.x}
                    y="110"
                    // Dark ink on the gold wedges, warm white on the dark ones.
                    fill={slice.premium ? "#17130a" : "#f4f1ea"}
                    fontSize="7"
                    fontWeight={slice.premium ? 800 : 700}
                    dominantBaseline="middle"
                    textAnchor={label.textAnchor}
                    transform={`rotate(${label.rotate} 110 110)`}
                    style={{ letterSpacing: "0.04em" }}
                  >
                    {slice.wedgeLabel}
                  </text>
                );
              })}
              <circle cx="110" cy="110" r="96" fill="url(#faceShade)" pointerEvents="none" />
            </g>

            {/* Rim and pegs: fixed, so the lights do not smear while it turns. */}
            <circle cx="110" cy="110" r="99.5" fill="none" stroke="url(#rim)" strokeWidth="6" />
            <circle cx="110" cy="110" r="95.5" fill="none" stroke="#000000" strokeOpacity="0.55" strokeWidth="1.2" />
            {slices.map((slice, index) => {
              const angle = ((index * wedgeAngle - 90) * Math.PI) / 180;
              return (
                <circle
                  key={`peg-${slice.id}`}
                  cx={110 + 99.5 * Math.cos(angle)}
                  cy={110 + 99.5 * Math.sin(angle)}
                  r="2.4"
                  fill="#f6ecc9"
                  stroke={GOLD_DEEP}
                  strokeWidth="0.5"
                />
              );
            })}

            {/* Hub */}
            <circle cx="110" cy="110" r="21" fill="url(#hub)" stroke="url(#rim)" strokeWidth="2.2" />
            <circle cx="110" cy="110" r="5.2" fill={GOLD} />
          </svg>

          {/* The pointer, over the rim at twelve o'clock. */}
          {/* THE POINTER HAS TO READ AGAINST THE RIM IT SITS ON. Gold on gold
              vanished; this is a dark collar with a gold face and a drop
              shadow, so the eye finds the stopping point immediately. */}
          <div
            aria-hidden
            className="absolute left-1/2 top-[-16px] -translate-x-1/2"
            style={{ filter: "drop-shadow(0 4px 6px rgba(0,0,0,0.75))" }}
          >
            <svg width="38" height="48" viewBox="0 0 38 48">
              <linearGradient id="ptr" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f3e3b4" />
                <stop offset="52%" stopColor={GOLD} />
                <stop offset="100%" stopColor="#6d5a26" />
              </linearGradient>
              <path d="M19 47 L4 14 A16 16 0 1 1 34 14 Z" fill={INK} />
              <path d="M19 43.5 L6.4 15 A13.4 13.4 0 1 1 31.6 15 Z" fill="url(#ptr)" />
              <circle cx="19" cy="15" r="5.4" fill={INK} />
              <circle cx="19" cy="15" r="2.1" fill={GOLD} />
            </svg>
          </div>
        </div>
      </div>

      <div className="mt-7 text-center">
        {!result && (
          <button
            type="button"
            onClick={spin}
            disabled={spinning}
            className="w-full rounded-full px-10 py-4 text-base font-semibold uppercase tracking-[0.14em] transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
            style={{
              background: `linear-gradient(180deg, #e3cd92 0%, ${GOLD} 45%, ${GOLD_DEEP} 100%)`,
              color: INK,
              boxShadow: `0 10px 30px -10px ${GOLD}88`,
            }}
          >
            {spinning ? "Spinning…" : "Spin the wheel"}
          </button>
        )}

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-lg px-4 py-3 text-sm"
            style={{ background: "rgba(220,38,38,0.12)", color: "#fca5a5", border: "1px solid rgba(220,38,38,0.3)" }}
          >
            {error}
          </p>
        )}

        {result && revealed && (
          <div
            className="mt-2 overflow-hidden rounded-2xl text-left"
            style={{ background: "var(--surface-1)", border: `1px solid ${GOLD}55` }}
          >
            <div className="px-5 py-4" style={{ background: `linear-gradient(180deg, ${GOLD}1f, transparent)` }}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em]" style={{ color: GOLD }}>
                {result.alreadySpun ? "Your prize" : "You won"}
              </p>
              <p className="mt-1 text-2xl font-semibold leading-tight" style={{ color: "var(--foreground)" }}>
                {result.label}
              </p>
              <p className="mt-2 text-sm" style={{ color: "var(--foreground-muted)" }}>
                {result.condition}
              </p>
            </div>

            <div className="px-5 pb-5">
              <div
                className="flex items-center justify-between rounded-xl px-4 py-3"
                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--border-soft)" }}
              >
                <span className="text-xs uppercase tracking-wider" style={{ color: "var(--foreground-muted)" }}>
                  {countdown.expired ? "Expired" : "Expires in"}
                </span>
                {!countdown.expired && (
                  <span className="font-mono text-xl font-semibold tabular-nums" style={{ color: GOLD }}>
                    {countdown.text}
                  </span>
                )}
              </div>

              {/* THE FIGURE BELONGS HERE, AND ONLY HERE.
                  disclosure.ts keeps the dollar minimum off the wedges on
                  purpose: before you have won anything it reads as a price of
                  entry. After you have won, it is the opposite — it is the one
                  fact that decides whether the prize is ever redeemed, and
                  withholding it sends someone to the catalogue to build a cart
                  that silently does not qualify.
                  Measured in production on 2026-09-17: a won GLOW (a $175
                  minimum) sent the customer to /products having been told only
                  "with a qualifying purchase". */}
              {!countdown.expired && result.minSubtotalCents > 0 && (
                <p className="mt-4 text-sm" style={{ color: "var(--foreground)" }}>
                  Spend {formatCents(result.minSubtotalCents)} or more to claim it.
                </p>
              )}

              {!countdown.expired && (
                <Link
                  href="/products"
                  className="mt-3 block rounded-full px-5 py-3.5 text-center text-sm font-semibold uppercase tracking-[0.12em]"
                  style={{ background: `linear-gradient(180deg, #e3cd92 0%, ${GOLD} 45%, ${GOLD_DEEP} 100%)`, color: INK }}
                >
                  Start shopping
                </Link>
              )}
              {/* WHAT THIS CAN HONESTLY PROMISE.
                  It used to say "on this device or any other" full stop. The
                  prize travels in an httpOnly cookie, and the endpoint that
                  puts it on a second device (/api/spin/claim) verifies a
                  SESSION — so "any other" is true only once you are signed in,
                  and until the cart started calling that endpoint it was not
                  true anywhere. Both halves are fixed; this says which is
                  which rather than over-promising again. */}
              <p className="mt-3 text-xs" style={{ color: "var(--foreground-muted)" }}>
                Saved to your account. It applies automatically at checkout here — sign in to use it on another device.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ---------------------------------------------------------------
          THE TERMS RENDER BEFORE ANYONE SPINS, and they are not a footer
          link or a modal behind the button: the odds, the expiry and the
          stacking rules are what make this an honest promotion rather
          than a slot machine, so they are on the page at the moment the
          decision is made.

          WHAT IS NOT HERE IS THE DOLLAR MINIMUM. See disclosure.ts — the
          figure moved into "Full terms" below and into the cart, which
          asks for it at the moment it is an achievable step rather than a
          toll. The condition itself is stated on every line.
          --------------------------------------------------------------- */}
      <section className="mt-12" aria-labelledby="spin-terms">
        {/* The terms do not change once you have spun, but the heading has to:
            "Before you spin" sitting under a prize you already hold reads as
            though the page has not noticed, and it is the section a customer
            scrolls to precisely when they are working out how to claim. */}
        <h2 id="spin-terms" className="text-[11px] font-semibold uppercase tracking-[0.2em]" style={{ color: GOLD }}>
          {result && revealed ? "How your reward works" : "Before you spin"}
        </h2>
        <ul className="mt-4 space-y-2.5 text-sm" style={{ color: "var(--foreground-muted)" }}>
          {terms.map((term) => (
            <li key={term} className="flex gap-2.5">
              <span aria-hidden style={{ color: GOLD }}>·</span>
              <span>{term}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-9" aria-labelledby="spin-prizes">
        <h2 id="spin-prizes" className="text-[11px] font-semibold uppercase tracking-[0.2em]" style={{ color: GOLD }}>
          What&apos;s on the wheel
        </h2>
        <ul className="mt-4 space-y-px overflow-hidden rounded-xl" style={{ border: "1px solid var(--border-soft)" }}>
          {prizes.map((prize) => (
            <li
              key={prize.id}
              className="flex items-start justify-between gap-4 px-4 py-3"
              style={{ background: prize.premium ? `${GOLD}0f` : "var(--surface-0)" }}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium" style={{ color: prize.premium ? GOLD : "var(--foreground)" }}>
                  {prize.label}
                </p>
                <p className="mt-0.5 text-xs" style={{ color: "var(--foreground-muted)" }}>
                  {prize.condition}
                </p>
              </div>
              {/* THE REAL ODDS. A reward sitting on two wedges is twice as
                  likely, and printing "1 in 16" beside each of them would
                  understate it twice over. */}
              <span
                className="shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] tabular-nums"
                style={{ background: "rgba(255,255,255,0.05)", color: "var(--foreground-muted)" }}
              >
                {prize.wedges} in {prize.outOf}
              </span>
            </li>
          ))}
        </ul>

        <details className="mt-4 rounded-xl px-4 py-3" style={{ border: "1px solid var(--border-soft)" }}>
          <summary className="cursor-pointer text-xs font-medium" style={{ color: "var(--foreground-muted)" }}>
            Full terms, including the qualifying order for each prize
          </summary>
          <ul className="mt-3 space-y-2">
            {prizes.map((prize) => (
              <li key={`${prize.id}-exact`} className="text-xs" style={{ color: "var(--foreground-muted)" }}>
                <span style={{ color: "var(--foreground)" }}>{prize.label}</span> — {prize.exactCondition}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs" style={{ color: "var(--foreground-subtle)" }}>
            Your cart will show exactly how much more is needed to claim your prize.
          </p>
        </details>

        <p className="mt-4 text-xs" style={{ color: "var(--foreground-subtle)" }}>
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

/**
 * Where one wedge's caption sits, and which way up it reads.
 *
 * THE -90 IS NOT COSMETIC. wedgePath draws from twelve o'clock
 * (`index * wedgeAngle - 90`), while an SVG rotate is measured from the +x axis
 * at three o'clock. Without the same offset every label sits a quarter-turn
 * from the wedge it names — the wheel still looks right and each prize is
 * captioned with a DIFFERENT prize's name.
 *
 * AND HALF THE WHEEL READS UPSIDE DOWN WITHOUT THE FLIP. A caption turned into
 * the left half (90°–270°) has been turned past vertical, so its glyphs hang
 * inverted; seven of the sixteen shipped that way. Nothing caught it because at
 * 340px a 7px label is a grey smudge either way — it only became obvious in a
 * 2400px render made for the invitation email.
 *
 * Turning such a label a further 180° stands it back up, and the anchor moves
 * to the opposite side of the face so the text still begins at the rim and runs
 * inward. The two land in the same place: the vector (-91, 0) turned by
 * `angle + 180` is exactly (91, 0) turned by `angle`, so the wedge a caption
 * names never changes — which is the property wedge-labels.test.ts pins.
 *
 * Exported because that test needs it; the component is the only caller.
 */
export function wedgeLabelGeometry(index: number, wedgeAngle: number): {
  x: string;
  rotate: number;
  textAnchor: "start" | "end";
} {
  const angle = (((index * wedgeAngle + wedgeAngle / 2 - 90) % 360) + 360) % 360;
  const flipped = angle > 90 && angle < 270;
  return {
    x: flipped ? "19" : "201",
    rotate: flipped ? angle + 180 : angle,
    textAnchor: flipped ? "start" : "end",
  };
}

/** One wedge as an SVG path, drawn clockwise from twelve o'clock. */
function wedgePath(index: number, wedgeAngle: number): string {
  const start = index * wedgeAngle - 90;
  const end = start + wedgeAngle;
  const radius = 96;
  const toPoint = (degrees: number) => {
    const radians = (degrees * Math.PI) / 180;
    return `${(110 + radius * Math.cos(radians)).toFixed(3)} ${(110 + radius * Math.sin(radians)).toFixed(3)}`;
  };
  return `M 110 110 L ${toPoint(start)} A ${radius} ${radius} 0 0 1 ${toPoint(end)} Z`;
}
