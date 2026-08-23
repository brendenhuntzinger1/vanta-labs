"use client";

import { useState } from "react";

// NOT IMPORTED — PASSED IN. fulfillment-buckets.ts is server-only, and that is
// correct: it reaches the database. The page hands these down instead, so the
// guide still renders from the one set of definitions the Workstation itself
// uses, rather than a second copy typed out here that drifts on the first
// change nobody remembers to mirror.
export interface OwnerGuideProps {
  buckets: readonly { id: string; label: string; description: string }[];
  exceptions: readonly { reason: string; label: string; action: string }[];
  carrierStaleHours: number;
  transitStaleDays: number;
}

// ---------------------------------------------------------------------------
// THE OWNER GUIDE.
//
// Written for the person packing the boxes, not for a developer. No column
// names, no status values, no jargon.
//
// THE RULE THAT KEEPS IT HONEST: the queue list and the exception list are
// RENDERED FROM THE SAME CONSTANTS THE WORKSTATION USES. They are not retyped
// here. Add a queue or an exception and it appears in this guide; change a
// threshold and the number in this text changes with it. A guide that is
// maintained by hand describes the software it was written against, which is
// the version that stops being true first.
//
// What is hand-written is only the part code cannot know: what the owner should
// DO, and what they should not.
//
// It is deliberately closed by default and visually quiet. This panel must
// never compete with the actual work on the screen.
// ---------------------------------------------------------------------------

type Section = { id: string; title: string; body: React.ReactNode };

/** What the owner does about each queue. Keyed to the real bucket ids. */
const queueAdvice = (carrierStaleHours: number): Record<string, { you: string; dont: string }> => ({
  ready: {
    you: "Put it in your next batch.",
    dont: "Don't hand-change its shipping status — the batch does that for you.",
  },
  in_progress: {
    you: "Finish picking and packing it, then buy the label.",
    dont: "Don't start a second batch for the same order.",
  },
  awaiting_carrier: {
    you: "Nothing. The label is bought and printed. Hand the parcel over.",
    dont: `Don't buy another label. If nothing scans within ${carrierStaleHours} hours it moves itself into Needs Attention.`,
  },
  in_transit: {
    you: "Nothing. The carrier has it and the customer has been emailed tracking.",
    dont: "Don't email the customer an update — they already got one.",
  },
  out_for_delivery: {
    you: "Nothing. It's on the van today.",
    dont: "Don't promise a time. The carrier controls this, not you.",
  },
  delivered: {
    you: "Nothing. The customer got a delivery email.",
    dont: "Don't close or archive it. Delivered is already the finished state.",
  },
  exceptions: {
    you: "Work these first, before you batch anything else.",
    dont: "Don't ship an order sitting here. Something is wrong with it.",
  },
  terminal: {
    you: "Nothing. This order is closed.",
    dont: "Don't reopen it. Send a replacement instead if the customer needs product.",
  },
});

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-white/15 text-[10px] text-zinc-400">
        {n}
      </span>
      <span className="text-sm leading-6 text-zinc-300">{children}</span>
    </li>
  );
}

function Flow() {
  const rows = [
    ["Customer pays", "Vanta confirms the payment and takes the vials out of stock."],
    ["Order appears in Ready to Fulfill", "Nothing to do yet — it's waiting for your next batch."],
    ["You create a batch", "Vanta groups the orders and fixes their order for the whole run."],
    ["You print the pick list", "One line per product, totalled — pull once per product, not once per order."],
    ["Vanta gets shipping rates", "Nothing is bought. Looking at rates never costs money."],
    ["You approve the purchase", "This is the only step that spends money, and it needs your confirmation."],
    ["You print one merged PDF", "One page per parcel, in the same order as the packing screen."],
    ["You pack in screen order", "Page 1 is the first order on screen. Page 2 is the second. Always."],
    ["You hand the parcels over", "You're done. Everything after this happens on its own."],
    ["The carrier scans it", "Vanta moves the order to In Transit and emails the customer their tracking."],
    ["It's delivered", "Vanta marks it delivered and emails the customer again."],
  ];
  return (
    <ol className="space-y-3">
      {rows.map(([what, means], i) => (
        <li key={what} className="grid gap-1 border-l border-white/10 pl-4 sm:grid-cols-[220px_1fr] sm:gap-4">
          <span className="text-sm font-semibold text-white">
            <span className="mr-2 text-[10px] text-zinc-500">{String(i + 1).padStart(2, "0")}</span>
            {what}
          </span>
          <span className="text-sm leading-6 text-zinc-400">{means}</span>
        </li>
      ))}
    </ol>
  );
}

export function FulfillmentOwnerGuide({
  buckets,
  exceptions,
  carrierStaleHours,
  transitStaleDays,
}: OwnerGuideProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string>("morning");

  const sections: Section[] = [
    {
      id: "morning",
      title: "Your morning",
      body: (
        <>
          <ol className="space-y-2.5">
            <Step n={1}>Open this page.</Step>
            <Step n={2}><strong className="text-white">Clear Needs Attention first.</strong> Never batch around a problem order.</Step>
            <Step n={3}>Select everything in Ready to Fulfill and create a batch.</Step>
            <Step n={4}>Print the pick list and pull the products.</Step>
            <Step n={5}>Review the shipping rates. This costs nothing.</Step>
            <Step n={6}>Approve the postage purchase. <strong className="text-white">This is the only step that spends money.</strong></Step>
            <Step n={7}>Print the merged label PDF.</Step>
            <Step n={8}>Pack in screen order — page 1 is the first order on screen.</Step>
            <Step n={9}>Hand the parcels to the carrier.</Step>
          </ol>
          <p className="mt-5 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.06] p-3 text-sm leading-6 text-emerald-100">
            After handoff you do nothing. Carrier scans move the orders along and send the
            customer emails on their own.
          </p>
        </>
      ),
    },
    {
      id: "flow",
      title: "What happens to an order",
      body: <Flow />,
    },
    {
      id: "queues",
      title: "What each queue means",
      body: (
        <div className="space-y-4">
          {buckets.map((bucket) => {
            const advice = queueAdvice(carrierStaleHours)[bucket.id];
            return (
              <div key={bucket.id} className="rounded-lg border border-white/10 bg-white/[0.02] p-3.5">
                <p className="text-sm font-semibold text-white">{bucket.label}</p>
                <p className="mt-1 text-sm leading-6 text-zinc-400">{bucket.description}</p>
                {advice ? (
                  <dl className="mt-2.5 space-y-1 text-sm">
                    <div className="flex gap-2">
                      <dt className="shrink-0 text-zinc-500">You:</dt>
                      <dd className="text-zinc-300">{advice.you}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="shrink-0 text-zinc-500">Don&apos;t:</dt>
                      <dd className="text-zinc-300">{advice.dont}</dd>
                    </div>
                  </dl>
                ) : null}
              </div>
            );
          })}
        </div>
      ),
    },
    {
      id: "attention",
      title: "Needs Attention, one by one",
      body: (
        <div className="space-y-3">
          <p className="text-sm leading-6 text-zinc-400">
            Every problem Vanta can spot, and what to do about it. These are the exact
            checks the queue runs — nothing here is decorative.
          </p>
          {exceptions.map((reason) => (
            <div key={reason.reason} className="rounded-lg border border-amber-400/20 bg-amber-400/[0.04] p-3.5">
              <p className="text-sm font-semibold text-amber-100">{reason.label}</p>
              <p className="mt-1 text-sm leading-6 text-zinc-300">{reason.action}</p>
            </div>
          ))}
        </div>
      ),
    },
    {
      id: "wrong",
      title: "When something goes wrong",
      body: (
        <div className="space-y-3.5 text-sm leading-6 text-zinc-300">
          <div>
            <p className="font-semibold text-white">The printer jammed or the label came out wrong</p>
            <p className="mt-1 text-zinc-400">
              Print it again. <strong className="text-white">Reprinting never buys new postage.</strong> The
              label already exists — you are just putting it on paper again. Never buy a
              second label because a print failed.
            </p>
          </div>
          <div>
            <p className="font-semibold text-white">I closed the page halfway through packing</p>
            <p className="mt-1 text-zinc-400">
              Open it again and carry on. The batch and its order are stored, not held in
              the browser. Refreshing, going back, or using a second tab does not lose your place.
            </p>
          </div>
          <div>
            <p className="font-semibold text-white">A label purchase failed partway through a batch</p>
            <p className="mt-1 text-zinc-400">
              The orders that succeeded stay succeeded. The one that failed stays visible.
              If Vanta could not tell whether the purchase went through, it holds the order
              rather than guessing — <strong className="text-white">check Shippo before buying that
              one again</strong>, because a second label is real money.
            </p>
          </div>
          <div>
            <p className="font-semibold text-white">The carrier never scanned a parcel</p>
            <p className="mt-1 text-zinc-400">
              After {carrierStaleHours} hours it moves into Needs Attention on
              its own. Check your shelf first — the usual answer is that the parcel is still
              there, or the pickup was missed.
            </p>
          </div>
          <div>
            <p className="font-semibold text-white">Tracking stopped moving</p>
            <p className="mt-1 text-zinc-400">
              After {transitStaleDays} days with no carrier update it moves into Needs
              Attention. Open a trace with the carrier, then decide whether to send a replacement.
            </p>
          </div>
          <div>
            <p className="font-semibold text-white">The customer says it arrived broken</p>
            <p className="mt-1 text-zinc-400">
              Open the order and create a replacement, choosing the affected items. The
              customer is not charged. It is <strong className="text-white">not a second sale</strong> — it
              adds no revenue, but it does take stock out, and its product cost and postage
              both count against your profit. It gets its own tracking, linked to the
              original order.
            </p>
          </div>
          <div>
            <p className="font-semibold text-white">The customer says it never arrived</p>
            <p className="mt-1 text-zinc-400">
              Check the tracking, the delivery scan and the address on the order before you
              send anything. If the carrier says delivered and the customer says otherwise,
              that is a carrier claim — not automatically a replacement.
            </p>
          </div>
          <div>
            <p className="font-semibold text-white">The customer wants a refund</p>
            <p className="mt-1 text-zinc-400">
              Your policy is replacements.{" "}
              <strong className="text-rose-200">
                Recording a refund in Vanta does not send money back to the customer.
              </strong>{" "}
              It only adjusts your own books. If you ever do refund someone, you have to move
              the money yourself through the payment processor.
            </p>
          </div>
        </div>
      ),
    },
    {
      id: "shippo",
      title: "How Shippo fits in",
      body: (
        <div className="space-y-3 text-sm leading-6 text-zinc-300">
          <p>
            You should not need to open Shippo to fulfil orders. Vanta talks to it for you:
            it asks for rates, shows them to you, buys the label you approve, and stores the
            tracking number, the postage you actually paid, and the printable label.
          </p>
          <p>
            After that it runs the other way. The carrier scans the parcel, Shippo tells
            Vanta, Vanta moves the order along and emails the customer.
          </p>
          <p className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
            <strong className="text-white">Buying a label is not the same as telling the customer it shipped.</strong>{" "}
            The shipping email waits for the carrier to actually take the parcel. That way a
            label printed on Friday for a Monday pickup does not tell someone their order is
            on its way over the weekend.
          </p>
          <p className="text-rose-200">
            Never buy a label in the Shippo dashboard for an order Vanta is handling. Vanta
            will not know about it, and you can end up paying for two.
          </p>
        </div>
      ),
    },
    {
      id: "profit",
      title: "How your profit is worked out",
      body: (
        <div className="space-y-3 text-sm leading-6 text-zinc-300">
          <p>For each order, Vanta starts with what the customer actually paid and takes off:</p>
          <ul className="space-y-1.5 pl-4">
            <li className="list-disc">what the products cost you</li>
            <li className="list-disc">the postage you actually paid for the label</li>
            <li className="list-disc">the payment processor&apos;s fee</li>
            <li className="list-disc">any ambassador commission on that order</li>
          </ul>
          <p>
            Sales tax is not profit — it is collected for the state and passed straight
            through, so it is shown but never counted.
          </p>
          <p className="rounded-lg border border-amber-400/20 bg-amber-400/[0.05] p-3 text-amber-100">
            <strong>The processor fee is an estimate.</strong> Your processor does not report
            the real fee back to Vanta, so it is worked out from a rate and labelled
            &ldquo;estimated&rdquo; everywhere it appears. Postage is not an estimate once a
            label is bought — that figure is what Shippo actually charged.
          </p>
          <p>
            Product costs are frozen at the moment of sale. Changing a product&apos;s cost
            today never rewrites what an old order earned.
          </p>
          <p>
            A replacement brings in no revenue, but its product cost and its postage both
            come off your profit. Five replacements on a hundred sales is still a hundred
            sales — and a hundred and five parcels.
          </p>
        </div>
      ),
    },
    {
      id: "never",
      title: "Things to never do",
      body: (
        <ul className="space-y-2.5 text-sm leading-6 text-zinc-300">
          {[
            "Don't buy a label in Shippo for an order Vanta is handling.",
            "Don't buy a second label because a print failed — reprint instead.",
            "Don't buy again when a label purchase was ambiguous. Check Shippo first.",
            "Don't ship an order sitting in Needs Attention.",
            "Don't hand-set a normal order to shipped. Carrier scans do that.",
            "Don't treat a replacement as a sale.",
            "Don't assume recording a refund returned the customer's money.",
            "Don't edit fulfillment states directly in the database.",
          ].map((line) => (
            <li key={line} className="flex gap-2.5">
              <span aria-hidden="true" className="mt-0.5 shrink-0 text-rose-300">✕</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      ),
    },
  ];

  const active = sections.find((s) => s.id === tab) ?? sections[0];

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-lg border border-white/12 bg-white/[0.03] px-3 py-1.5 text-xs text-zinc-300 transition hover:border-white/25 hover:text-white"
      >
        <span aria-hidden="true" className="text-zinc-500">?</span>
        Owner Guide
        <span aria-hidden="true" className="text-zinc-500">{open ? "−" : "+"}</span>
      </button>

      {open ? (
        <div className="mt-3 overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]">
          <div className="flex flex-wrap gap-1 border-b border-white/10 p-2">
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => setTab(section.id)}
                aria-current={section.id === tab}
                className={
                  section.id === tab
                    ? "rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-medium text-white"
                    : "rounded-md px-2.5 py-1.5 text-xs text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
                }
              >
                {section.title}
              </button>
            ))}
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-4 sm:p-5">
            <h2 className="mb-3 text-sm font-semibold text-white">{active.title}</h2>
            {active.body}
          </div>
        </div>
      ) : null}
    </div>
  );
}
