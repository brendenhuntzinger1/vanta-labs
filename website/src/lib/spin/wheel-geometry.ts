/**
 * Where a wedge is, and where its label sits on it.
 *
 * Pure, and lifted out of spin-wheel.tsx so the invitation's preview draws the
 * SAME board the shopper spins. Two copies of this arithmetic would mean a card
 * advertising wedges that are not on the wheel.
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
export function wedgePath(index: number, wedgeAngle: number): string {
  const start = index * wedgeAngle - 90;
  const end = start + wedgeAngle;
  const radius = 96;
  const toPoint = (degrees: number) => {
    const radians = (degrees * Math.PI) / 180;
    return `${(110 + radius * Math.cos(radians)).toFixed(3)} ${(110 + radius * Math.sin(radians)).toFixed(3)}`;
  };
  return `M 110 110 L ${toPoint(start)} A ${radius} ${radius} 0 0 1 ${toPoint(end)} Z`;
}

/**
 * The two wedges filled gold, so the jackpot reads at a glance.
 *
 * Lifted out of the /spin page with the geometry: the preview on the invitation
 * has to highlight the same wedges the wheel does, or the card is selling a
 * board that does not exist.
 */
export const PREMIUM_PRIZE_IDS = new Set(["klow", "glow"]);
