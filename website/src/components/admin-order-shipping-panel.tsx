"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { fulfillmentStatusLabel, normalizeLegacyStatus, type FulfillmentStatus } from "@/lib/order-pipeline";

// ---------------------------------------------------------------------------
// The fulfillment workstation.
//
// One screen, one order, in the order the work actually happens:
//
//   Mark packed -> Get rates -> pick a service -> Buy label -> Print -> (Void)
//
// Two things drive every decision in here.
//
// MONEY. "Buy label" is the only control on this page that spends money, and it
// spends it at a carrier where a duplicate is a real postage charge for a parcel
// that will never ship. The server's atomic claim is what actually guarantees
// exactly-once (purchaseLabelForOrder in src/lib/shippo/service.ts) — this
// component's job is to never *invite* the mistake: the button needs a second,
// explicit confirmation that names the carrier, the service and the price; it is
// disabled while a request is in flight; it disappears entirely once a label
// exists; and a synchronous ref lock means two clicks landing in the same React
// tick cannot both reach fetch(). A response that says "postage was charged but
// something after that failed" locks purchasing for the rest of the page life
// rather than offering a retry that would buy a second label.
//
// PHONES. The owner packs parcels standing at a bench with a phone in one hand.
// Everything is a single column below `sm`, every control clears 44px, nothing
// makes the page scroll sideways, and the one wide thing (the item table) scrolls
// inside its own box.
// ---------------------------------------------------------------------------

// ------------------------------------------------------------------ types ---

export interface ShippingPanelAddress {
  street1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
}

export interface ShippingPanelItem {
  key: string;
  name: string;
  /** The catalog SKU, or null when the product row has none. */
  sku: string | null;
  quantity: number;
  /** Packaged weight of ONE unit, as the parcel math resolved it. */
  unitWeightOz: number | null;
  lineWeightOz: number | null;
}

export interface ShippingPanelPreset {
  id: string;
  name: string;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  emptyWeightOz: number;
  isDefault?: boolean;
}

export interface ShippingPanelLabel {
  transactionId: string;
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  /** Integer cents. null means "not known" — rendered as Pending, never $0.00. */
  postageCostCents: number | null;
  purchasedAt: string | null;
}

export interface ShippingPanelParcel {
  /** What the parcel currently declares, override included. */
  weightOz: number | null;
  overridden: boolean;
  overrideOz: number | null;
  preset: ShippingPanelPreset | null;
  /** Set when the parcel could not be built at all (bad data, DB failure). */
  error: string | null;
}

export interface AdminOrderShippingPanelProps {
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  address: ShippingPanelAddress;
  items: ShippingPanelItem[];
  orderTotal: number;
  shippingCharged: number;
  paymentStatus: string;
  fulfillmentStatus: string;
  /** False for an order whose payment is not verified — actions stay locked. */
  canFulfill: boolean;
  parcel: ShippingPanelParcel;
  packages: ShippingPanelPreset[];
  label: ShippingPanelLabel | null;
  labelVoidedAt: string | null;
  /** The purchase claim is held but no label landed: in flight, or interrupted. */
  purchaseClaimStuck: boolean;
  paidAt: string | null;
  packedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  shippo: { configured: boolean; mode: "test" | "live"; label: string };
}

interface RateOption {
  id: string;
  carrier: string;
  service: string;
  serviceToken: string;
  amountCents: number;
  currency: string;
  estimatedDays: number | null;
  durationTerms: string | null;
}

type NoticeTone = "info" | "success" | "warn" | "error";
interface Notice {
  tone: NoticeTone;
  text: string;
}

// ---------------------------------------------------------------- helpers ---

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function dollars(value: number): string {
  return USD.format(Number.isFinite(value) ? value : 0);
}

/**
 * Money that might not be known yet.
 *
 * An unknown postage cost renders as "Pending" and NEVER as "$0.00": zero is a
 * real price meaning the shipment was free, and showing it for "we have not
 * found out yet" is how a store convinces itself its margins are better than
 * they are.
 */
function costLabel(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "Pending";
  return USD.format(cents / 100);
}

function ounces(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const oz = Math.round(value * 100) / 100;
  if (oz < 16) return `${oz} oz`;
  const pounds = Math.floor(oz / 16);
  const remainder = Math.round((oz - pounds * 16) * 100) / 100;
  return `${oz} oz (${pounds} lb${remainder > 0 ? ` ${remainder} oz` : ""})`;
}

function when(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

const NOTICE_TONE: Record<NoticeTone, string> = {
  info: "border-white/15 bg-white/[0.05] text-zinc-200",
  success: "border-emerald-300/30 bg-emerald-300/10 text-emerald-100",
  warn: "border-amber-300/30 bg-amber-300/10 text-amber-100",
  error: "border-rose-300/30 bg-rose-300/10 text-rose-100",
};

const STATUS_TONE: Partial<Record<FulfillmentStatus, string>> = {
  awaiting_payment: "border-zinc-400/30 bg-zinc-400/10 text-zinc-300",
  paid: "border-sky-300/40 bg-sky-300/10 text-sky-200",
  ready_to_fulfill: "border-amber-300/40 bg-amber-300/10 text-amber-200",
  packed: "border-violet-300/40 bg-violet-300/10 text-violet-200",
  label_purchased: "border-indigo-300/40 bg-indigo-300/10 text-indigo-200",
  shipped: "border-cyan-300/40 bg-cyan-300/10 text-cyan-200",
  in_transit: "border-cyan-300/40 bg-cyan-300/10 text-cyan-200",
  out_for_delivery: "border-teal-300/40 bg-teal-300/10 text-teal-200",
  delivered: "border-emerald-300/40 bg-emerald-300/10 text-emerald-200",
  cancelled: "border-zinc-400/30 bg-zinc-400/10 text-zinc-400",
  refunded: "border-rose-300/40 bg-rose-300/10 text-rose-200",
  returned: "border-orange-300/40 bg-orange-300/10 text-orange-200",
};

/**
 * One badge for every status in the pipeline, legacy values included.
 *
 * Exported because the fulfillment queue shows the same statuses, and two
 * colour tables for one vocabulary drift the moment a status is added.
 */
export function FulfillmentStatusPill({ status }: { status: string }) {
  const normalized = normalizeLegacyStatus(status);
  const tone = (normalized && STATUS_TONE[normalized]) || "border-white/20 bg-white/5 text-zinc-300";
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${tone}`}>
      {fulfillmentStatusLabel(status)}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1">
      <dt className="text-[11px] uppercase tracking-[0.12em] text-zinc-500">{label}</dt>
      <dd className="min-w-0 break-words text-right text-sm text-zinc-200">{children}</dd>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* Clipboard is unavailable over plain HTTP and in some in-app browsers. */
        }
      }}
      className="vl-focus-ring inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-white/20 bg-white/[0.05] px-3 text-xs font-semibold text-white transition hover:border-white/50"
    >
      {copied ? "✓ Copied" : label}
    </button>
  );
}

// -------------------------------------------------------------- component ---

export function AdminOrderShippingPanel(props: AdminOrderShippingPanelProps) {
  const {
    orderId,
    orderNumber,
    customerName,
    customerEmail,
    customerPhone,
    address,
    items,
    orderTotal,
    shippingCharged,
    paymentStatus,
    canFulfill,
    parcel,
    packages,
    purchaseClaimStuck,
    paidAt,
    shippedAt,
    deliveredAt,
    shippo,
  } = props;

  const router = useRouter();

  // Server truth, mirrored into state so an action can update the screen
  // immediately without waiting for a refresh to land.
  const [label, setLabel] = useState<ShippingPanelLabel | null>(props.label);
  const [status, setStatus] = useState(props.fulfillmentStatus);
  const [packedAt, setPackedAt] = useState(props.packedAt);

  // Parcel settings, editable until a label exists.
  const [presetId, setPresetId] = useState(parcel.preset?.id ?? "");
  const [weightInput, setWeightInput] = useState(parcel.overrideOz == null ? "" : String(parcel.overrideOz));
  const [savedPresetId, setSavedPresetId] = useState(parcel.preset?.id ?? "");
  const [savedOverrideOz, setSavedOverrideOz] = useState<number | null>(parcel.overrideOz);

  const [rates, setRates] = useState<RateOption[] | null>(null);
  const [quoted, setQuoted] = useState<{ weightOz: number; packageName: string | null } | null>(null);
  const [selectedRateId, setSelectedRateId] = useState("");

  const [pending, setPending] = useState<null | "packed" | "rates" | "buy" | "void">(null);
  const [confirming, setConfirming] = useState<null | "buy" | "void">(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [parcelWarning, setParcelWarning] = useState<string | null>(null);
  /**
   * Set only by a response that says postage was charged but the follow-up
   * failed. It is deliberately sticky for the life of the page: the one thing
   * that must not happen next is another purchase.
   */
  const [chargedWarning, setChargedWarning] = useState<string | null>(null);
  const [purchaseLocked, setPurchaseLocked] = useState(false);

  // Re-sync from the server after router.refresh(). The key changes only when
  // the underlying row changed, so this never clobbers state the admin is
  // mid-edit on. It is also what clears a `purchase_in_progress` lock once the
  // winning request's label actually shows up.
  const serverKey = [
    props.label?.transactionId ?? "",
    props.label?.postageCostCents ?? "",
    props.labelVoidedAt ?? "",
    props.fulfillmentStatus,
    props.packedAt ?? "",
  ].join("|");
  const [syncedKey, setSyncedKey] = useState(serverKey);
  if (syncedKey !== serverKey) {
    setSyncedKey(serverKey);
    setLabel(props.label);
    setStatus(props.fulfillmentStatus);
    setPackedAt(props.packedAt);
    if (!chargedWarning) setPurchaseLocked(false);
  }

  /**
   * Synchronous lock. `pending` drives the disabled attributes, but state
   * updates are async — two clicks dispatched in one tick would both see
   * `pending === null`. A ref is set before the first `await`, so the second
   * click returns immediately.
   */
  const inFlight = useRef(false);

  const run = useCallback(
    async (kind: "packed" | "rates" | "buy" | "void", work: () => Promise<void>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(kind);
      try {
        await work();
      } catch {
        if (kind === "buy") {
          // A dropped connection is NOT proof that nothing happened — the
          // request may have reached Shippo and bought a label before the socket
          // died. The outcome is unknown, and the only safe response to an
          // unknown purchase is to stop offering another one.
          setPurchaseLocked(true);
          setChargedWarning(
            "The connection dropped while buying this label, so it is not known whether postage was charged. Reload the page: if no label appears, check the Shippo dashboard for this order before buying another.",
          );
          router.refresh();
        } else {
          setNotice({ tone: "error", text: "Network error — nothing was saved. Try again." });
        }
      } finally {
        inFlight.current = false;
        setPending(null);
      }
    },
    [router],
  );

  const normalized = normalizeLegacyStatus(status);
  const hasLabel = label !== null;
  const isTerminal =
    normalized === "delivered" || normalized === "cancelled" || normalized === "refunded" || normalized === "returned";
  const alreadyPacked = Boolean(packedAt) || normalized === "packed";
  const shippoReady = shippo.configured;

  // Carrier-required destination fields. Checked here purely so the owner is
  // told *before* a failed quote; the server validates again and is the
  // authority.
  const country = (address.country ?? "").trim().toUpperCase();
  const stateRequired = country === "" || country === "US" || country === "USA" || country === "UNITED STATES" || country === "CA";
  const missingAddress = [
    !address.street1?.trim() ? "street address" : null,
    !address.city?.trim() ? "city" : null,
    stateRequired && !address.state?.trim() ? "state" : null,
    !address.zip?.trim() ? "ZIP" : null,
  ].filter((value): value is string => value !== null);

  const parcelDirty =
    presetId !== savedPresetId || parseWeightInput(weightInput).value !== savedOverrideOz;

  const canQuote = canFulfill && shippoReady && !hasLabel && !parcel.error && missingAddress.length === 0 && !isTerminal;
  const selectedRate = rates?.find((rate) => rate.id === selectedRateId) ?? null;
  const canBuy = canQuote && !purchaseLocked && !purchaseClaimStuck && selectedRate !== null;

  const addressLines = [
    customerName,
    address.street1,
    [address.city, address.state].filter(Boolean).join(", ") + (address.zip ? ` ${address.zip}` : ""),
    address.country,
  ]
    .map((line) => (line ?? "").trim())
    .filter((line) => line.length > 0);
  const addressBlock = addressLines.join("\n");

  // ------------------------------------------------------------- actions ---

  const markPacked = () =>
    run("packed", async () => {
      setNotice(null);
      // Goes through the existing order-status endpoint. Only offered while the
      // order has no label: that endpoint also rewrites the order_shipments row,
      // and calling it after a label was bought would blank the stored carrier
      // and tracking number.
      const res = await fetch(`/api/admin/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_status", fulfillmentStatus: "packed" }),
      });
      const json = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !json?.success) {
        setNotice({ tone: "error", text: json?.error ?? "Could not mark this order packed." });
        return;
      }
      setStatus("packed");
      // Deliberately not stamping a local packed-at: that endpoint writes the
      // status column only, and inventing a timestamp the database does not
      // hold would vanish on the next refresh.
      setNotice({ tone: "success", text: "Marked packed." });
      router.refresh();
    });

  const getRates = () =>
    run("rates", async () => {
      setNotice(null);
      setParcelWarning(null);
      const parsed = parseWeightInput(weightInput);
      if (!parsed.ok) {
        setNotice({ tone: "error", text: "The weight override must be a positive number of ounces, or blank." });
        return;
      }

      const res = await fetch(`/api/admin/orders/${orderId}/shipping/rates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The parcel the admin is looking at. Quoting buys nothing, so this is
        // free to re-run after any change here.
        body: JSON.stringify({
          packagePresetId: presetId || null,
          weightOverrideOz: parsed.value,
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | {
            success?: boolean;
            error?: string;
            code?: string;
            rates?: RateOption[];
            parcel?: { weightOz?: number };
            package?: { id?: string; name?: string } | null;
          }
        | null;

      if (!res.ok || !json?.success) {
        setRates(null);
        setQuoted(null);
        setNotice({ tone: "error", text: json?.error ?? "Could not get shipping rates." });
        return;
      }

      const usable = (json.rates ?? []).filter((rate) => Number.isFinite(rate.amountCents));
      if (usable.length === 0) {
        setRates(null);
        setQuoted(null);
        setNotice({ tone: "error", text: "Shippo returned no purchasable rates for this parcel." });
        return;
      }

      const appliedWeight = Number(json.parcel?.weightOz);
      const appliedPresetId = json.package?.id ?? null;
      const appliedPresetName = json.package?.name ?? null;

      // Trust the quote, not the form. The rates below were priced for whatever
      // parcel the SERVER used, and that is what a purchase will be charged for —
      // so if the boxes on screen did not make it into the quote, say so loudly
      // rather than letting the owner believe they re-weighed the parcel.
      const applied = wasParcelApplied({
        requestedPresetId: presetId,
        savedPresetId,
        requestedOverrideOz: parsed.value,
        savedOverrideOz,
        appliedWeight,
        appliedPresetId,
      });
      if (parcelDirty && !applied) {
        setParcelWarning(
          `Your parcel changes were not applied. These rates were priced for ${ounces(appliedWeight)} in ` +
            `${appliedPresetName ?? "the default package"} — the settings already stored on this order.`,
        );
      } else if (parcelDirty) {
        setSavedPresetId(appliedPresetId ?? presetId);
        setSavedOverrideOz(parsed.value);
      }

      setRates(usable);
      setQuoted({ weightOz: appliedWeight, packageName: appliedPresetName });
      // Cheapest first, from the server. Pre-selecting it saves a tap; it still
      // takes two deliberate clicks to spend anything.
      setSelectedRateId(usable[0].id);
      setNotice({ tone: "info", text: `${usable.length} service${usable.length === 1 ? "" : "s"} available.` });
    });

  // Quote automatically when the page opens, so the carrier choices are already
  // on screen instead of behind a click. Fetching a rate costs nothing and buys
  // nothing — only "Buy label" spends money, and that stays deliberate.
  //
  // Keyed on the order, and guarded by a ref rather than by `rates === null`:
  // a quote that legitimately returns zero usable rates leaves `rates` empty,
  // and re-running on that condition would retry forever against a parcel that
  // cannot be quoted.
  const autoQuotedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!canQuote) return;
    if (autoQuotedFor.current === orderId) return;
    autoQuotedFor.current = orderId;
    void getRates();
    // getRates is recreated every render; depending on it would re-fire the
    // effect continuously. The ref above is what actually enforces once-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canQuote, orderId]);

  const buyLabel = () =>
    run("buy", async () => {
      // Re-checked inside the lock: by the time this runs the label may already
      // exist, and nothing below is worth a second charge.
      if (hasLabel || purchaseLocked || !selectedRate) return;
      setNotice(null);
      setConfirming(null);

      const res = await fetch(`/api/admin/orders/${orderId}/shipping/label`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rateId: selectedRate.id }),
      });
      const json = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string; code?: string; label?: (ShippingPanelLabel & { reused?: boolean }) | null }
        | null;

      // A label in the body means one EXISTS — on success, and on the two
      // failures that happen after the money is already spent.
      if (json?.label) {
        setLabel(toPanelLabel(json.label));
      }

      if (res.ok && json?.success && json.label) {
        setRates(null);
        setSelectedRateId("");
        setStatus("label_purchased");
        setNotice(
          json.label.reused
            ? { tone: "info", text: "This order already had a label — nothing was bought twice." }
            : {
                tone: "success",
                text: `Label purchased: ${[json.label.carrier, json.label.service].filter(Boolean).join(" ")} for ${costLabel(json.label.postageCostCents)}.`,
              },
        );
        router.refresh();
        return;
      }

      if (json?.label) {
        // Postage was charged. Never offer a retry from here.
        setPurchaseLocked(true);
        setChargedWarning(
          `${json.error ?? "The purchase failed after the label was bought."} The postage WAS charged — print the label below and check this order in the Shippo dashboard. Do not buy another.`,
        );
        router.refresh();
        return;
      }

      if (json?.code === "purchase_in_progress") {
        // Someone (or some retry) is mid-purchase. Nothing was bought twice, and
        // sending this again cannot help — so stop offering it and refresh.
        setPurchaseLocked(true);
        setNotice({ tone: "warn", text: json.error ?? "A label purchase for this order is already in progress." });
        router.refresh();
        return;
      }

      if (json?.code === "rate_expired") {
        setRates(null);
        setSelectedRateId("");
        setQuoted(null);
        setNotice({ tone: "warn", text: json.error ?? "That quote expired. Get rates again and pick a service." });
        return;
      }

      setNotice({ tone: "error", text: json?.error ?? "The label purchase failed. Nothing was bought." });
    });

  const voidLabel = () =>
    run("void", async () => {
      setNotice(null);
      setConfirming(null);
      const res = await fetch(`/api/admin/orders/${orderId}/shipping/label`, { method: "DELETE" });
      const json = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string; voided?: { refundPending?: boolean; alreadyVoided?: boolean } }
        | null;

      if (!res.ok || !json?.success) {
        setNotice({ tone: "error", text: json?.error ?? "Could not void this label." });
        return;
      }

      setLabel(null);
      setRates(null);
      setSelectedRateId("");
      setQuoted(null);
      setPurchaseLocked(false);
      setStatus("packed");
      setNotice({
        tone: "success",
        text: json.voided?.alreadyVoided
          ? "That label was already void — nothing changed."
          : json.voided?.refundPending
            ? "Label voided. The carrier refund is pending; the recorded postage cost has been cleared."
            : "Label voided and refunded. The recorded postage cost has been cleared.",
      });
      router.refresh();
    });

  // -------------------------------------------------------------- render ---

  const printHref = `/api/admin/orders/${orderId}/shipping/label/print`;

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-300">Fulfillment</h2>
          <p className="mt-1 break-all font-mono text-2xl font-bold leading-tight text-white sm:text-3xl">{orderNumber}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!shippo.configured ? (
            <span className="inline-flex items-center rounded-full border border-rose-300/40 bg-rose-300/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-rose-200">
              Shippo not configured
            </span>
          ) : shippo.mode === "test" ? (
            <span className="inline-flex items-center rounded-full border border-amber-300/50 bg-amber-300/15 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-amber-200">
              Test mode
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full border border-emerald-300/40 bg-emerald-300/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-emerald-200">
              Live postage
            </span>
          )}
          <FulfillmentStatusPill status={status} />
        </div>
      </header>

      {/* ---------------------------------------------------------- alerts --- */}

      {chargedWarning ? (
        <p className="mt-4 rounded-xl border border-rose-300/40 bg-rose-300/10 px-3 py-2.5 text-[13px] font-medium text-rose-100">
          {chargedWarning}
        </p>
      ) : null}

      {!shippo.configured ? (
        <p className="mt-4 rounded-xl border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-[13px] text-rose-100">
          <strong>SHIPPO_API_TOKEN is not set on the server.</strong> Rates and labels are unavailable until it is.
        </p>
      ) : shippo.mode === "test" ? (
        <p className="mt-4 rounded-xl border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-[13px] text-amber-100">
          Shippo is in <strong>test mode</strong>. Labels bought here are not real postage and cannot be used to ship a
          parcel.
        </p>
      ) : null}

      {!canFulfill ? (
        <p className="mt-4 rounded-xl border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-[13px] text-amber-100">
          Payment is <strong>{paymentStatus || "unverified"}</strong>. Nothing ships until the payment is verified — the
          actions below stay locked.
        </p>
      ) : null}

      {missingAddress.length > 0 ? (
        <p className="mt-4 rounded-xl border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-[13px] text-rose-100">
          The delivery address is missing <strong>{missingAddress.join(", ")}</strong>. Carriers reject incomplete
          addresses, so rates cannot be quoted until it is fixed on the order.
        </p>
      ) : null}

      {parcel.error ? (
        <p className="mt-4 rounded-xl border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-[13px] text-rose-100">
          {parcel.error}
        </p>
      ) : null}

      {purchaseClaimStuck && !hasLabel ? (
        <p className="mt-4 rounded-xl border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-[13px] text-amber-100">
          A label purchase for this order is in progress or was interrupted. Nothing was bought twice. Refresh in a
          moment; if it stays like this, check the Shippo dashboard before buying anything.
        </p>
      ) : null}

      {notice ? (
        <p className={`mt-4 rounded-xl border px-3 py-2 text-[13px] ${NOTICE_TONE[notice.tone]}`}>{notice.text}</p>
      ) : null}

      {/* ------------------------------------------------- customer / order --- */}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Ship to</p>
            {addressBlock ? <CopyButton value={addressBlock} label="Copy" /> : null}
          </div>
          <p className="mt-2 whitespace-pre-line break-words text-sm text-zinc-100">{addressBlock || "No address on file"}</p>
          <p className="mt-2 break-all text-xs text-zinc-400">{customerEmail || "No email"}</p>
          {customerPhone ? <p className="mt-0.5 text-xs text-zinc-400">{customerPhone}</p> : null}
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
          <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Order</p>
          <dl className="mt-1 divide-y divide-white/5">
            <Row label="Order total">
              <span className="tabular-nums">{dollars(orderTotal)}</span>
            </Row>
            <Row label="Shipping charged">
              <span className="tabular-nums">{dollars(shippingCharged)}</span>
            </Row>
            <Row label="Postage cost">
              <span className={`tabular-nums ${label && label.postageCostCents == null ? "text-amber-300" : ""}`}>
                {label ? costLabel(label.postageCostCents) : "Pending"}
              </span>
            </Row>
            <Row label="Payment">{paymentStatus || "—"}</Row>
            <Row label="Fulfillment">{fulfillmentStatusLabel(status)}</Row>
          </dl>
        </div>
      </div>

      {/* ------------------------------------------------------------ items --- */}

      <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
        <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Pick list</p>
        {/* The one wide element on the page: it scrolls inside this box so the
            page itself never scrolls sideways on a phone. */}
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[30rem] border-collapse text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-[0.1em] text-zinc-500">
                <th scope="col" className="py-1.5 pr-3 font-medium">Product</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">SKU</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">Qty</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">Unit oz</th>
                <th scope="col" className="py-1.5 text-right font-medium">Line oz</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-3 text-zinc-500">No items recorded on this order.</td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={item.key}>
                    <td className="py-2 pr-3 text-zinc-100">{item.name}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-zinc-400">{item.sku || "—"}</td>
                    <td className="py-2 pr-3 text-right font-semibold tabular-nums text-white">× {item.quantity}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-zinc-400">
                      {item.unitWeightOz == null ? "—" : item.unitWeightOz}
                    </td>
                    <td className="py-2 text-right tabular-nums text-zinc-400">
                      {item.lineWeightOz == null ? "—" : item.lineWeightOz}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ----------------------------------------------------------- parcel --- */}

      <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Parcel</p>
          {parcel.overridden ? (
            <span className="vl-chip !py-1 !text-[10px]">Weight overridden</span>
          ) : null}
        </div>

        <dl className="mt-1 divide-y divide-white/5">
          <Row label="Declared weight">
            <span className="tabular-nums">{ounces(parcel.weightOz)}</span>
          </Row>
          <Row label="Package">
            {parcel.preset
              ? `${parcel.preset.name} · ${parcel.preset.lengthIn} × ${parcel.preset.widthIn} × ${parcel.preset.heightIn} in · ${parcel.preset.emptyWeightOz} oz empty`
              : "Default package"}
          </Row>
          {quoted ? (
            <Row label="Quoted as">
              <span className="tabular-nums">
                {ounces(quoted.weightOz)}
                {quoted.packageName ? ` · ${quoted.packageName}` : ""}
              </span>
            </Row>
          ) : null}
        </dl>

        {hasLabel ? (
          <p className="mt-3 text-[11px] text-zinc-500">
            The parcel is locked while a label exists — the label was priced for these dimensions. Void it to change them.
          </p>
        ) : (
          <div className="mt-3 grid gap-3 border-t border-white/10 pt-3 sm:grid-cols-2">
            <label className="text-xs text-zinc-400">
              Package
              <select
                value={presetId}
                onChange={(event) => setPresetId(event.target.value)}
                disabled={!canFulfill || pending !== null}
                className="vl-input mt-1 w-full px-3 py-2.5 text-sm disabled:opacity-50"
              >
                <option value="">Use the default package</option>
                {packages.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name} — {preset.lengthIn} × {preset.widthIn} × {preset.heightIn} in
                    {preset.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-zinc-400">
              Weight override (oz)
              <input
                value={weightInput}
                onChange={(event) => setWeightInput(event.target.value)}
                disabled={!canFulfill || pending !== null}
                inputMode="decimal"
                placeholder={parcel.weightOz == null ? "computed" : String(parcel.weightOz)}
                className="vl-input mt-1 w-full px-3 py-2.5 text-sm disabled:opacity-50"
              />
              <span className="mt-1 block text-[11px] text-zinc-500">
                Blank uses the computed weight (packaging + every unit). A value here replaces the whole total.
              </span>
            </label>
          </div>
        )}

        {parcelWarning ? (
          <p className="mt-3 rounded-xl border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-[13px] text-amber-100">
            {parcelWarning}
          </p>
        ) : parcelDirty && !hasLabel ? (
          <p className="mt-3 text-[11px] text-amber-300/90">
            Parcel changed — get rates again so the price matches the box you are actually shipping.
          </p>
        ) : null}
      </div>

      {/* ---------------------------------------------------------- actions --- */}

      <div className="mt-5 border-t border-white/10 pt-4">
        <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Actions</p>

        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button
            type="button"
            onClick={markPacked}
            disabled={!canFulfill || hasLabel || alreadyPacked || isTerminal || pending !== null}
            className="vl-btn-secondary w-full px-5 text-sm disabled:opacity-40 sm:w-auto"
          >
            {pending === "packed" ? "Saving…" : alreadyPacked ? "✓ Packed" : "1 · Mark packed"}
          </button>

          <button
            type="button"
            onClick={getRates}
            disabled={!canQuote || pending !== null}
            className="vl-btn-secondary w-full px-5 text-sm disabled:opacity-40 sm:w-auto"
          >
            {pending === "rates" ? "Quoting…" : rates ? "Refresh rates" : "2 · Get rates"}
          </button>
        </div>

        {/* --- rate picker --- */}
        {rates && !hasLabel ? (
          <div className="mt-4">
            <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">3 · Choose a service</p>
            <div className="mt-2 grid gap-2">
              {rates.map((rate) => {
                const selected = rate.id === selectedRateId;
                return (
                  <label
                    key={rate.id}
                    className={`flex min-h-[56px] cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition ${
                      selected ? "border-cyan-300/50 bg-cyan-300/10" : "border-white/10 bg-white/[0.02] hover:border-white/25"
                    }`}
                  >
                    <input
                      type="radio"
                      name={`vl-rate-${orderId}`}
                      value={rate.id}
                      checked={selected}
                      onChange={() => setSelectedRateId(rate.id)}
                      disabled={pending !== null}
                      className="h-5 w-5 shrink-0 accent-cyan-300"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-white">
                        {rate.carrier} · {rate.service || rate.serviceToken}
                      </span>
                      <span className="block text-[11px] text-zinc-500">
                        {rate.estimatedDays != null
                          ? `≈ ${rate.estimatedDays} day${rate.estimatedDays === 1 ? "" : "s"}`
                          : rate.durationTerms || "Delivery estimate unavailable"}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums text-sm font-semibold text-white">
                      {costLabel(rate.amountCents)}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* --- buy --- */}
        {!hasLabel ? (
          <div className="mt-4">
            {confirming === "buy" && selectedRate ? (
              // Deliberate step two. Nothing is spent until this Confirm is
              // pressed, and it names exactly what is being bought.
              <div className="rounded-xl border border-white/25 bg-white/[0.05] p-3.5">
                <p className="text-sm text-zinc-100">
                  Buy <strong>{selectedRate.carrier} {selectedRate.service || selectedRate.serviceToken}</strong> for{" "}
                  <strong className="tabular-nums">{costLabel(selectedRate.amountCents)}</strong>?
                </p>
                <p className="mt-1 text-[12px] text-zinc-400">
                  {shippo.mode === "live"
                    ? "This charges your Shippo account for real postage. It can be voided afterwards, but the refund is not instant."
                    : "Shippo is in test mode — no real postage will be charged."}
                </p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={buyLabel}
                    disabled={!canBuy || pending !== null}
                    className="vl-btn-primary w-full px-5 text-sm disabled:opacity-40 sm:w-auto"
                  >
                    {pending === "buy" ? "Buying…" : "Confirm purchase"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    disabled={pending !== null}
                    className="vl-btn-secondary w-full px-5 text-sm disabled:opacity-40 sm:w-auto"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming("buy")}
                disabled={!canBuy || pending !== null}
                className="vl-btn-primary w-full px-5 text-sm disabled:opacity-40 sm:w-auto"
              >
                4 · Buy label
              </button>
            )}

            {!selectedRate && canQuote ? (
              <p className="mt-2 text-[11px] text-zinc-500">Get rates and pick a service to enable the purchase.</p>
            ) : null}
            {purchaseLocked ? (
              <p className="mt-2 text-[11px] text-amber-300/90">
                Purchasing is locked on this screen to stop a second charge. Reload the page once the order settles.
              </p>
            ) : null}
          </div>
        ) : null}

        {/* --- print / void --- */}
        {hasLabel && label ? (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <a
              href={printHref}
              target="_blank"
              rel="noopener noreferrer"
              className="vl-btn-primary w-full px-5 text-sm sm:w-auto"
            >
              5 · Print label
            </a>
            <a
              href={`${printHref}?download=1`}
              target="_blank"
              rel="noopener noreferrer"
              className="vl-btn-secondary w-full px-5 text-sm sm:w-auto"
            >
              Reprint / download PDF
            </a>
            {confirming === "void" ? (
              <div className="w-full rounded-xl border border-rose-300/30 bg-rose-300/10 p-3.5">
                <p className="text-sm text-rose-100">
                  Void this label and refund the postage? The tracking number is discarded, the recorded cost is cleared,
                  and the order goes back to Packed. Do not void a parcel that has already been handed to the carrier.
                </p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={voidLabel}
                    disabled={pending !== null}
                    className="vl-btn-secondary w-full px-5 text-sm !border-rose-300/50 !text-rose-100 disabled:opacity-40 sm:w-auto"
                  >
                    {pending === "void" ? "Voiding…" : "Confirm void"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    disabled={pending !== null}
                    className="vl-btn-secondary w-full px-5 text-sm disabled:opacity-40 sm:w-auto"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming("void")}
                disabled={pending !== null}
                className="vl-btn-secondary w-full px-5 text-sm disabled:opacity-40 sm:w-auto"
              >
                Void label
              </button>
            )}
          </div>
        ) : null}
      </div>

      {/* ------------------------------------------------------------ label --- */}

      {label ? (
        <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
          <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Label</p>
          <dl className="mt-1 divide-y divide-white/5">
            <Row label="Carrier">{label.carrier || "—"}</Row>
            <Row label="Service">{label.service || "—"}</Row>
            <Row label="Tracking">
              {label.trackingNumber ? (
                label.trackingUrl ? (
                  <a
                    href={label.trackingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="vl-focus-ring break-all font-mono text-[13px] text-cyan-200 underline decoration-cyan-300/40 underline-offset-2"
                  >
                    {label.trackingNumber}
                  </a>
                ) : (
                  <span className="break-all font-mono text-[13px]">{label.trackingNumber}</span>
                )
              ) : (
                "—"
              )}
            </Row>
            <Row label="Postage paid">
              <span className={`tabular-nums ${label.postageCostCents == null ? "text-amber-300" : ""}`}>
                {costLabel(label.postageCostCents)}
              </span>
            </Row>
            <Row label="Purchased">
              <time suppressHydrationWarning>{when(label.purchasedAt)}</time>
            </Row>
            <Row label="Shippo transaction">
              <span className="break-all font-mono text-[11px] text-zinc-400">{label.transactionId}</span>
            </Row>
          </dl>
          {label.postageCostCents == null ? (
            <p className="mt-2 text-[11px] text-amber-300/90">
              The exact postage has not been recorded, so profit for this order stays on its estimate. Enter it in the
              profit panel once you have the figure from Shippo.
            </p>
          ) : null}
          {label.trackingNumber ? (
            <div className="mt-3">
              <CopyButton value={label.trackingNumber} label="Copy tracking #" />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* -------------------------------------------------------- timestamps --- */}

      <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-white/10 pt-4 sm:grid-cols-5">
        {(
          [
            ["Paid", paidAt],
            ["Packed", packedAt],
            ["Label", label?.purchasedAt ?? null],
            ["Shipped", shippedAt],
            ["Delivered", deliveredAt],
          ] as Array<[string, string | null]>
        ).map(([heading, value]) => (
          <div key={heading}>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">{heading}</dt>
            <dd className={`mt-0.5 text-[12px] ${value ? "text-zinc-300" : "text-zinc-600"}`}>
              <time suppressHydrationWarning>{when(value)}</time>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ------------------------------------------------------------------ utils ---

/** Blank means "use the computed weight"; anything else must be a positive number. */
function parseWeightInput(raw: string): { ok: boolean; value: number | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return { ok: false, value: null };
  return { ok: true, value: parsed };
}

/**
 * Did the quote actually use the parcel the admin asked for?
 *
 * The rates response echoes the parcel the SERVER priced. Comparing it against
 * the form is the only way to tell the owner truthfully whether re-weighing the
 * parcel changed the price they are about to pay.
 */
function wasParcelApplied(input: {
  requestedPresetId: string;
  savedPresetId: string;
  requestedOverrideOz: number | null;
  savedOverrideOz: number | null;
  appliedWeight: number;
  appliedPresetId: string | null;
}): boolean {
  if (input.requestedPresetId) {
    if (input.requestedPresetId !== input.appliedPresetId) return false;
  } else if (input.savedPresetId && input.appliedPresetId === input.savedPresetId) {
    // The admin cleared the explicit package, but the quote still used it.
    return false;
  }
  if (!Number.isFinite(input.appliedWeight)) return false;
  if (input.requestedOverrideOz != null) return approxEq(input.appliedWeight, input.requestedOverrideOz);
  // The override was cleared: the quote must no longer be using the stored one.
  if (input.savedOverrideOz != null) return !approxEq(input.appliedWeight, input.savedOverrideOz);
  return true;
}

function toPanelLabel(label: ShippingPanelLabel & { reused?: boolean }): ShippingPanelLabel {
  return {
    transactionId: label.transactionId,
    carrier: label.carrier ?? null,
    service: label.service ?? null,
    trackingNumber: label.trackingNumber ?? null,
    trackingUrl: label.trackingUrl ?? null,
    postageCostCents:
      label.postageCostCents == null || !Number.isFinite(label.postageCostCents) ? null : label.postageCostCents,
    purchasedAt: label.purchasedAt ?? null,
  };
}
