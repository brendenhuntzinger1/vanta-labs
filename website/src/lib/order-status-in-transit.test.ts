import { describe, expect, it } from "vitest";

import { getOrderProgress } from "@/lib/order-status";
import { stepIndexForFulfillment } from "@/components/order-status-timeline";
import { PIPELINE_PROGRESSION } from "@/lib/order-pipeline";

// ---------------------------------------------------------------------------
// A PARCEL THAT IS MOVING MUST NOT READ AS "PAYMENT CONFIRMED".
//
// The Shippo tracking webhook writes `in_transit` and `out_for_delivery` on
// carrier scans (order-pipeline.ts ladder). The customer's order tracker
// mapped neither `in_transit` nor `packed`, so an order whose parcel was with
// the carrier rendered "Payment confirmed" with the Confirmed step current —
// exactly the "no movement for days" the tracker exists to prevent. A
// production order sat in `in_transit` in that state when this was found.
// ---------------------------------------------------------------------------

describe("getOrderProgress across the whole fulfilment ladder", () => {
  it("shows a moving parcel as on the way", () => {
    for (const status of ["in_transit", "out_for_delivery", "shipped"]) {
      const progress = getOrderProgress("paid", status);
      expect(progress.headline, status).toBe("On the way");
      expect(progress.activeIndex, status).toBe(3);
    }
  });

  it("shows every pre-carrier working status as being prepared", () => {
    for (const status of ["processing", "awaiting_fulfillment", "ready_to_fulfill", "packed", "label_purchased", "partially_fulfilled"]) {
      const progress = getOrderProgress("paid", status);
      expect(progress.headline, status).toBe("Being prepared");
      expect(progress.activeIndex, status).toBe(2);
    }
  });

  it("never leaves a paid order on the ladder past 'paid' reading as merely confirmed", () => {
    // Everything on the progression ladder after the payment step means the
    // shop or the carrier has done something with the order.
    const afterPaid = PIPELINE_PROGRESSION.slice(PIPELINE_PROGRESSION.indexOf("paid") + 1);
    for (const status of afterPaid) {
      expect(getOrderProgress("paid", status).activeIndex, status).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("stepIndexForFulfillment (confirmation page timeline)", () => {
  it("treats a moving parcel as shipped", () => {
    for (const status of ["in_transit", "out_for_delivery"]) {
      expect(stepIndexForFulfillment(status), status).toBe(2);
    }
  });

  it("treats packed / ready / label-bought as processing", () => {
    for (const status of ["packed", "ready_to_fulfill", "label_purchased"]) {
      expect(stepIndexForFulfillment(status), status).toBe(1);
    }
  });
});
