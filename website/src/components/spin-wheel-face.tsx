import { SPIN_PRIZES } from "@/lib/spin/prize-table";
import { PREMIUM_PRIZE_IDS, wedgeLabelGeometry, wedgePath } from "@/lib/spin/wheel-geometry";

/**
 * The wheel's face, drawn once and used twice.
 *
 * WHY IT IS ITS OWN COMPONENT. The invitation now shows the wheel, and a wheel
 * drawn a second time is a wheel that drifts: a wedge added to the prize table
 * would appear on one and not the other, and the card would be advertising a
 * board the shopper never spins. This reads SPIN_PRIZES and the same geometry
 * the live wheel turns, so the picture on the card IS the board.
 *
 * STATIC AND SILENT. No rotation, no pointer, no hub press, aria-hidden — it is
 * a picture of the prizes, and every word on it is repeated in the text beside
 * it for anyone who cannot see it.
 */
const INK = "#0b0b0c";
const GOLD = "#c7ae5e";
const GOLD_DEEP = "#8f7734";
const WEDGE_TONES = ["#16233d", "#1a1a1c", "#123630", "#221118", "#1a1a1c", "#13203a"];

export function SpinWheelFace({ className }: { className?: string }) {
  const slices = SPIN_PRIZES;
  const wedgeAngle = 360 / slices.length;

  return (
    <svg viewBox="0 0 220 220" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="previewRim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e6d29a" />
          <stop offset="38%" stopColor={GOLD} />
          <stop offset="62%" stopColor={GOLD_DEEP} />
          <stop offset="100%" stopColor="#e2cd93" />
        </linearGradient>
        <linearGradient id="previewGoldWedge" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#e3cb8d" />
          <stop offset="100%" stopColor={GOLD_DEEP} />
        </linearGradient>
        <radialGradient id="previewFaceShade" cx="50%" cy="38%" r="72%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.10" />
          <stop offset="70%" stopColor="#000000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.45" />
        </radialGradient>
      </defs>

      <circle cx="110" cy="110" r="96" fill={INK} />
      {slices.map((slice, index) => (
        <path
          key={slice.id}
          d={wedgePath(index, wedgeAngle)}
          fill={PREMIUM_PRIZE_IDS.has(slice.id) ? "url(#previewGoldWedge)" : WEDGE_TONES[index % WEDGE_TONES.length]}
          stroke={INK}
          strokeWidth="0.7"
        />
      ))}
      {slices.map((slice, index) => {
        const label = wedgeLabelGeometry(index, wedgeAngle);
        return (
          <text
            key={`${slice.id}-preview-label`}
            x={label.x}
            y="110"
            fill={PREMIUM_PRIZE_IDS.has(slice.id) ? "#17130a" : "#f4f1ea"}
            fontSize="7"
            fontWeight={PREMIUM_PRIZE_IDS.has(slice.id) ? 800 : 700}
            dominantBaseline="middle"
            textAnchor={label.textAnchor}
            transform={`rotate(${label.rotate} 110 110)`}
            style={{ letterSpacing: "0.04em" }}
          >
            {slice.wedgeLabel}
          </text>
        );
      })}
      <circle cx="110" cy="110" r="96" fill="url(#previewFaceShade)" pointerEvents="none" />
      <circle cx="110" cy="110" r="99.5" fill="none" stroke="url(#previewRim)" strokeWidth="6" />
      <circle cx="110" cy="110" r="95.5" fill="none" stroke="#000000" strokeOpacity="0.55" strokeWidth="1.2" />
      <circle cx="110" cy="110" r="21" fill={INK} stroke="url(#previewRim)" strokeWidth="2.2" />
      <circle cx="110" cy="110" r="5.2" fill={GOLD} />
    </svg>
  );
}

/** How many wedges hand over an actual vial — stated from the table, not typed. */
export const FREE_VIAL_WEDGES = SPIN_PRIZES.filter((prize) => prize.reward.kind === "free_product").length;

/** Every wedge, so the card can never claim a prize the board does not carry. */
export const WEDGE_COUNT = SPIN_PRIZES.length;
