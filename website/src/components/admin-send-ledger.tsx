import type { SendLedger, SendLedgerRow } from "@/lib/email/send-ledger";

/**
 * "Is the mail arriving, and is anyone opening it?" — one panel, every channel.
 *
 * Deliberately a server component with no state: it renders what the ledger
 * read, and every number on it is a count of rows rather than a rate computed
 * against a denominator the reader cannot see. Where a denominator IS used it
 * is printed next to the number ("14 of 20"), because the failure this panel
 * exists to correct was a rate of zero over an unstated denominator being read
 * as "nobody opened anything" when the real answer was "this kind of mail was
 * never measured".
 */

function shortDate(value: string | null): string {
  if (!value) return "—";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    + " " + at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** A count with its denominator, never a bare percentage over an unknown base. */
function outOf(count: number, total: number): string {
  if (total <= 0) return "—";
  return `${count} of ${total}`;
}

function DeliveryCell({ row }: { row: SendLedgerRow }) {
  if (row.status === "failed") {
    return <span className="text-rose-300">Never sent</span>;
  }
  if (row.complained) return <span className="text-rose-300">Marked spam</span>;
  if (row.bounced) return <span className="text-amber-300">Bounced</span>;
  // A reported failure is not silence. email.failed used to parse as "ignored",
  // so a permanently rejected message rendered "No word yet" — identical to one
  // still in flight — while the channel row read "0 of 1 delivered" with
  // nothing saying why.
  if (row.failed) {
    return (
      <span className="text-rose-300" title="The provider reported it could not send this message. Not a bounce: nothing was accepted and then returned.">
        Could not send
      </span>
    );
  }
  if (row.delivered) {
    return (
      <span className="text-emerald-300">
        Delivered
        {row.deliveryEvidence === "address" ? (
          <span className="ml-1 text-[11px] text-zinc-500" title="Matched to the provider's delivery by address and time, not by message id — this kind of mail is sent by Supabase and records no id.">
            (by address)
          </span>
        ) : null}
      </span>
    );
  }
  return <span className="text-zinc-500" title="No delivery event has been received for this send.">No word yet</span>;
}

function OpenCell({ row }: { row: SendLedgerRow }) {
  if (!row.openTracked) {
    return (
      <span className="text-zinc-600" title="Account mail carries no tracking pixel on purpose — a remote image in a password reset is a phishing signature.">
        Not tracked
      </span>
    );
  }
  if (row.openedAt) return <span className="text-emerald-300">{shortDate(row.openedAt)}</span>;
  return <span className="text-zinc-600">—</span>;
}

export function AdminSendLedger({ ledger }: { ledger: SendLedger }) {
  if (ledger.error) {
    return (
      <section className="vl-panel rounded-[1.8rem] p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Delivery &amp; engagement</h2>
        <p className="mt-3 text-sm text-amber-300">
          Could not read the send log, so this panel is showing nothing rather than zeroes: {ledger.error}
        </p>
      </section>
    );
  }

  const { totals } = ledger;

  return (
    <section className="vl-panel rounded-[1.8rem] p-5 sm:p-6">
      <h2 className="text-lg font-semibold text-white">Delivery &amp; engagement</h2>
      <p className="mt-2 max-w-3xl text-sm text-zinc-400">
        Every message the system sent, whatever sent it — campaigns, automated sequences, cart reminders and account
        mail — with the provider&apos;s delivery confirmation joined to it. &ldquo;Not tracked&rdquo; means that kind of
        mail carries no open tracking, which is not the same as nobody opening it.
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Sent", value: String(totals.sent), hint: `last ${ledger.rows.length} sends` },
          { label: "Confirmed delivered", value: outOf(totals.delivered, totals.deliveryKnown), hint: "of the sends the provider reported on" },
          { label: "Opened", value: outOf(totals.opened, totals.openTracked), hint: "of the sends that carry tracking" },
          { label: "Clicked", value: outOf(totals.clicked, totals.openTracked), hint: "of the sends that carry tracking" },
        ].map((stat) => (
          <div key={stat.label} className="rounded-xl border border-white/10 bg-black/20 p-3">
            <dt className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">{stat.label}</dt>
            <dd className="mt-1 text-lg font-semibold text-white">{stat.value}</dd>
            <p className="text-[11px] text-zinc-500">{stat.hint}</p>
          </div>
        ))}
      </dl>

      {ledger.channels.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500">Nothing has been sent yet.</p>
      ) : (
        <>
          <h3 className="mt-6 text-sm font-semibold uppercase tracking-[0.14em] text-zinc-400">By kind of mail</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">
                  <th className="py-2 pr-3">Kind</th>
                  <th className="py-2 pr-3">Sent</th>
                  <th className="py-2 pr-3" title="Confirmed by the provider's delivery webhook, over the sends it reported on">Delivered</th>
                  <th className="py-2 pr-3">Bounced</th>
                  <th className="py-2 pr-3" title="Over the sends that carry open tracking">Opened</th>
                  <th className="py-2 pr-3">Clicked</th>
                  <th className="py-2 pr-3">Last sent</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {ledger.channels.map((channel) => (
                  <tr key={channel.channel} className="border-t border-white/5" data-testid={`ledger-channel-${channel.channel}`}>
                    <td className="py-2.5 pr-3 font-medium text-white">{channel.channel}</td>
                    <td className="py-2.5 pr-3">{channel.sent}</td>
                    <td className="py-2.5 pr-3">{outOf(channel.delivered, channel.deliveryKnown)}</td>
                    <td className="py-2.5 pr-3">
                      <span className={channel.bounced > 0 ? "text-amber-300" : ""}>{channel.bounced}</span>
                    </td>
                    <td className="py-2.5 pr-3">
                      {channel.openTracked === 0
                        ? <span className="text-zinc-600">Not tracked</span>
                        : outOf(channel.opened, channel.openTracked)}
                    </td>
                    <td className="py-2.5 pr-3">
                      {channel.openTracked === 0
                        ? <span className="text-zinc-600">Not tracked</span>
                        : outOf(channel.clicked, channel.openTracked)}
                    </td>
                    <td className="py-2.5 pr-3 text-zinc-400">{shortDate(channel.lastSentAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="mt-8 text-sm font-semibold uppercase tracking-[0.14em] text-zinc-400">Who got what</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">
                  <th className="py-2 pr-3">Recipient</th>
                  <th className="py-2 pr-3">Message</th>
                  <th className="py-2 pr-3">Sent</th>
                  <th className="py-2 pr-3">Delivery</th>
                  <th className="py-2 pr-3">Opened</th>
                  <th className="py-2 pr-3">Clicked</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {ledger.rows.map((row) => (
                  <tr key={row.id} className="border-t border-white/5" data-testid="ledger-send-row">
                    <td className="py-2.5 pr-3 text-white">{row.recipient || "—"}</td>
                    <td className="py-2.5 pr-3">{row.channel}</td>
                    <td className="py-2.5 pr-3 text-zinc-400">{shortDate(row.sentAt)}</td>
                    <td className="py-2.5 pr-3"><DeliveryCell row={row} /></td>
                    <td className="py-2.5 pr-3"><OpenCell row={row} /></td>
                    <td className="py-2.5 pr-3">
                      {!row.openTracked
                        ? <span className="text-zinc-600">Not tracked</span>
                        : row.clickedAt
                          ? <span className="text-emerald-300">{shortDate(row.clickedAt)}</span>
                          : <span className="text-zinc-600">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {ledger.truncated ? (
            <p className="mt-3 text-[11px] text-zinc-500">
              Showing the most recent {ledger.rows.length} sends. Older ones are in the database but not on this page.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
