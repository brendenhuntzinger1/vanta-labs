import { describe, expect, it } from "vitest";

import {
  classifyShipmentStatus,
  fulfillmentProgressRank,
  fulfillmentStatusForSignal,
  isLabelEvent,
  signalNotifiesCustomer,
} from "@/lib/fulfillment/shipment-signal";

describe("a printed label is not a shipment", () => {
  it("classifies every label/pre-transit vocabulary as pre_transit", () => {
    for (const status of [
      "label_created",
      "label_printed",
      "label_purchased",
      "Label Generated",
      "labeled",
      "labelled",
      "ready_to_ship",
      "awaiting_pickup",
      "pending_pickup",
      "manifested",
      "pre_transit",
      "PRE-TRANSIT",
      "information_received",
      "unshipped",
    ]) {
      expect(classifyShipmentStatus(status), status).toBe("pre_transit");
    }
  });

  it("never emails the customer for a pre-transit signal", () => {
    expect(signalNotifiesCustomer("pre_transit")).toBe(false);
  });

  it("leaves a labelled order reading as 'being prepared', not 'shipped'", () => {
    expect(fulfillmentStatusForSignal("pre_transit")).toBe("awaiting_fulfillment");
  });

  it("demotes a shipped-looking status that arrives on a LABEL event", () => {
    // The failure this exists to prevent: a provider that reports buying a
    // label as `status: "shipped"`. The event type gives it away.
    expect(classifyShipmentStatus("shipped", "label_created")).toBe("pre_transit");
    expect(classifyShipmentStatus("in_transit", "shipment.label_purchased")).toBe("pre_transit");
    expect(classifyShipmentStatus("shipped", "manifest_generated")).toBe("pre_transit");
  });

  it("treats an unrecognised status on a label event as pre-transit", () => {
    expect(classifyShipmentStatus("something_new", "label_created")).toBe("pre_transit");
  });

  it("recognises label events by name", () => {
    expect(isLabelEvent("label_created")).toBe(true);
    expect(isLabelEvent("shipment.manifest")).toBe(true);
    expect(isLabelEvent("tracking_updated")).toBe(false);
    expect(isLabelEvent(undefined)).toBe(false);
  });
});

describe("real movement still ships", () => {
  it("classifies carrier-possession vocabulary as shipped", () => {
    for (const status of ["shipped", "in_transit", "accepted", "picked_up", "dispatched", "out_for_delivery", "En Route"]) {
      expect(classifyShipmentStatus(status), status).toBe("shipped");
    }
  });

  it("sends the shipping email on a genuine shipped signal", () => {
    expect(signalNotifiesCustomer("shipped")).toBe(true);
    expect(fulfillmentStatusForSignal("shipped")).toBe("shipped");
  });

  it("still handles delivery and cancellation", () => {
    expect(classifyShipmentStatus("delivered")).toBe("delivered");
    expect(classifyShipmentStatus("cancelled")).toBe("cancelled");
    expect(classifyShipmentStatus("canceled")).toBe("cancelled");
    expect(signalNotifiesCustomer("delivered")).toBe(true);
  });

  it("says nothing about statuses that carry no shipment meaning", () => {
    expect(classifyShipmentStatus("processing")).toBe("none");
    expect(classifyShipmentStatus("")).toBe("none");
    expect(classifyShipmentStatus(undefined)).toBe("none");
    expect(fulfillmentStatusForSignal("none")).toBeNull();
  });
});

describe("shipment progress only moves forward", () => {
  it("ranks the pipeline in order", () => {
    expect(fulfillmentProgressRank("awaiting_fulfillment")).toBe(1);
    expect(fulfillmentProgressRank("shipped")).toBe(2);
    expect(fulfillmentProgressRank("delivered")).toBe(3);
  });

  it("ranks a late label event BELOW an already-shipped order, so it is suppressed", () => {
    const late = fulfillmentProgressRank(fulfillmentStatusForSignal("pre_transit"));
    expect(late).toBeLessThan(fulfillmentProgressRank("shipped"));
  });

  it("gives unknown statuses rank 0 so they never block a real transition", () => {
    expect(fulfillmentProgressRank("who_knows")).toBe(0);
    expect(fulfillmentProgressRank(null)).toBe(0);
  });
});
