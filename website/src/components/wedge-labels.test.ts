import { describe, expect, it } from "vitest";

import { wedgeLabelGeometry } from "@/components/spin-wheel";
import { SPIN_PRIZES } from "@/lib/spin/prize-table";

// ---------------------------------------------------------------------------
// THE WHEEL'S CAPTIONS: UPRIGHT, AND ON THE RIGHT WEDGE.
//
// Two separate bugs have shipped in this one transform, and neither was
// visible at the size the wheel is actually drawn:
//
//   1. A missing -90 put every caption a quarter-turn from the wedge it names,
//      so each prize was labelled with a different prize's name.
//   2. Captions turned into the left half of the face were turned past
//      vertical and hung upside down. Seven of the sixteen did. At 340px a 7px
//      inverted label just looks like a label; it only became obvious in the
//      2400px render made for the invitation email.
//
// Both are geometry, so both are checkable without a renderer. The test works
// in the wheel's own coordinate space: the face is centred at (110, 110) and a
// caption is anchored 91 units out.
// ---------------------------------------------------------------------------

const CENTRE = 110;
const RADIUS = 91;

/** Where a caption's rim end actually lands, after its rotation is applied. */
function anchorPoint(index: number, wedgeAngle: number): { x: number; y: number } {
  const { x, rotate } = wedgeLabelGeometry(index, wedgeAngle);
  // The anchor sits on the x axis, either side of the centre, before rotation.
  const offset = Number(x) - CENTRE;
  const radians = (rotate * Math.PI) / 180;
  return {
    x: CENTRE + offset * Math.cos(radians),
    y: CENTRE + offset * Math.sin(radians),
  };
}

/** The wedge a caption visually sits in, as an index, from where it landed. */
function wedgeAtPoint(point: { x: number; y: number }, wedgeAngle: number): number {
  // Wedges are drawn clockwise from twelve o'clock, so undo that offset before
  // dividing — the same -90 the geometry itself applies.
  const degrees = (Math.atan2(point.y - CENTRE, point.x - CENTRE) * 180) / Math.PI;
  const fromTop = ((degrees + 90) % 360 + 360) % 360;
  return Math.floor(fromTop / wedgeAngle);
}

describe("wedge label geometry", () => {
  const count = SPIN_PRIZES.length;
  const wedgeAngle = 360 / count;

  it("draws the wheel this test is about", () => {
    // If the wheel stops being sixteen wedges the cases below still hold, but
    // the numbers quoted in the comments above stop matching. Pinned so the
    // discrepancy is loud rather than confusing.
    expect(count).toBe(16);
    expect(wedgeAngle).toBe(22.5);
  });

  it("never leaves a caption upside down", () => {
    const inverted: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const { rotate } = wedgeLabelGeometry(index, wedgeAngle);
      // Glyphs hang inverted once their baseline is turned past vertical.
      const normalized = ((rotate % 360) + 360) % 360;
      if (normalized > 90 && normalized < 270) inverted.push(index);
    }
    expect(inverted).toEqual([]);
  });

  it("keeps every caption inside the wedge it names", () => {
    for (let index = 0; index < count; index += 1) {
      expect(wedgeAtPoint(anchorPoint(index, wedgeAngle), wedgeAngle)).toBe(index);
    }
  });

  it("anchors the caption at the rim whichever way it is turned", () => {
    for (let index = 0; index < count; index += 1) {
      const point = anchorPoint(index, wedgeAngle);
      const distance = Math.hypot(point.x - CENTRE, point.y - CENTRE);
      // A flipped caption that forgot to move its anchor would land at the
      // centre, not the rim, and the label would run off the far side.
      expect(distance).toBeCloseTo(RADIUS, 6);
    }
  });

  it("runs the text inward from the rim on both halves", () => {
    for (let index = 0; index < count; index += 1) {
      const { x, textAnchor } = wedgeLabelGeometry(index, wedgeAngle);
      // Anchored past the centre means the text must START there and grow back
      // towards it; anchored short of it means the text must END there.
      expect(textAnchor).toBe(Number(x) > CENTRE ? "end" : "start");
    }
  });
});
