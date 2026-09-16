/**
 * Segments (spec §7). Two groups:
 *
 *   * PROPERTY segments use contact properties and the vl_* custom properties
 *     the store pushes, so they can be created before any event has flowed.
 *   * EVENT segments use Omnisend events and can only be created once the
 *     brand has recorded that event at least once (Omnisend refuses earlier),
 *     so the build script creates them on a second pass after deployment.
 */

const subscribed = (channel) => ({ property: "subscriptionStatus", operator: "equals", value: "subscribed", channels: [channel] });
const tagAny = (tags) => ({ property: "tags", operator: "anyOf", value: tags });
const tagNone = (tags) => ({ property: "tags", operator: "noneOf", value: tags });
const customDateInLast = (name, value, unit = "days") => ({ property: "custom", name, valueType: "date", operator: "inTheLast", value, unit });
const customDateNotInLast = (name, value, unit = "days") => ({ property: "custom", name, valueType: "date", operator: "notInTheLast", value, unit });
const customNumberMoreThan = (name, value) => ({ property: "custom", name, valueType: "number", operator: "moreThan", value });
const customBool = (name, value) => ({ property: "custom", name, valueType: "bool", operator: "equals", value });
/** The store writes its readiness flags as the text "yes" / "no", so they are matched as text, not bool. */
const customYes = (name) => ({ property: "custom", name, valueType: "text", operator: "anyOf", value: ["yes"] });
const contact = (filters, junction = "and") => ({ entity: "contact", junction, filters });
const event = (filters, junction = "and") => ({ entity: "event", junction, filters });
const seg = (name, conditions) => ({ name, conditionGroups: [{ conditions }] });

export const PROPERTY_SEGMENTS = {
  "vl-subscribers": () => seg("VL · Subscribers (email)", [contact([subscribed("email")])]),
  "vl-sms-subscribers": () => seg("VL · SMS subscribers", [contact([subscribed("sms")])]),
  "vl-customers": () => seg("VL · Customers", [contact([tagAny(["customer"])])]),
  "vl-attested": () => seg("VL · Attested account holders", [contact([customBool("vl_attested", true)])]),
  "vl-never-bought": () => seg("VL · Subscribers who never bought", [contact([subscribed("email"), tagNone(["customer"])])]),
  "vl-bought-30d": () => seg("VL · Bought in last 30 days", [contact([customDateInLast("vl_last_order_at", 30)])]),
  "vl-lapsed-60": () => seg("VL · Lapsed 60 days", [contact([tagAny(["customer"]), customDateNotInLast("vl_last_order_at", 60)])]),
  "vl-lapsed-90": () => seg("VL · Lapsed 90 days", [contact([tagAny(["customer"]), customDateNotInLast("vl_last_order_at", 90)])]),
  "vl-vip": () => seg("VL · VIP (spent over 500)", [contact([customNumberMoreThan("vl_total_spent", 500)])]),
  "vl-campaign-audience": () => seg("VL · Campaign audience", [contact([subscribed("email"), tagNone(["sunset"])])]),
  // Abandonment splits (spec §6). The store sets vl_recovery_gift_ready and
  // vl_recovery_ready to "yes" only once the gift or code exists, so the
  // *-3-gift* and *-3-code* variants can never show a blank card.
  "vl-recovery-gift-ready": () => seg("VL · Recovery gift ready", [contact([customYes("vl_recovery_gift_ready")])]),
  "vl-recovery-code-ready": () => seg("VL · Recovery code ready", [contact([customYes("vl_recovery_ready")])]),
  // The win-back split: the nightly sweep sets vl_winback_ready to "yes" once the code is minted.
  "vl-winback-ready": () => seg("VL · Win-back code ready", [contact([customYes("vl_winback_ready")])]),
  // The welcome split: the opt-in upsert sets vl_welcome_ready to "yes" only when it minted a welcome code; a checkout-sourced opt-in gets none.
  "vl-welcome-ready": () => seg("VL · Welcome code ready", [contact([customYes("vl_welcome_ready")])]),
};

export const EVENT_SEGMENTS = {
  "vl-engaged-90": () => seg("VL · Engaged 90 days", [
    contact([subscribed("email")]),
    event([
      { name: "opened message", operator: "has", count: "atLeast", value: 1, period: { operator: "inTheLast", unit: "days", value: 90 } },
      { name: "clicked message", operator: "has", count: "atLeast", value: 1, period: { operator: "inTheLast", unit: "days", value: 90 } },
    ], "or"),
  ]),
  "vl-unengaged-120": () => seg("VL · Unengaged 120 days", [
    contact([subscribed("email"), { property: "dateAdded", operator: "notInTheLast", value: 120, unit: "days" }]),
    event([
      { name: "opened message", operator: "hasNot", count: "atLeast", value: 1, period: { operator: "inTheLast", unit: "days", value: 120 } },
      { name: "clicked message", operator: "hasNot", count: "atLeast", value: 1, period: { operator: "inTheLast", unit: "days", value: 120 } },
    ]),
  ]),
  "vl-browsed-no-order-30d": () => seg("VL · Browsed, no order (30 days)", [
    event([{ name: "viewed product", origin: "api", operator: "has", count: "atLeast", value: 1, period: { operator: "inTheLast", unit: "days", value: 30 } }]),
    event([{ name: "paid for order", origin: "api", operator: "hasNot", count: "atLeast", value: 1, period: { operator: "inTheLast", unit: "days", value: 30 } }]),
  ]),
  "vl-repeat-customers": () => seg("VL · Repeat customers", [
    event([{ name: "paid for order", origin: "api", operator: "has", count: "atLeast", value: 2 }]),
  ]),
};

export const SEGMENTS = { ...PROPERTY_SEGMENTS, ...EVENT_SEGMENTS };
