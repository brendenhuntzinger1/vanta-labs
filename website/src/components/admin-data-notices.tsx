// ---------------------------------------------------------------------------
// THE TWO SENTENCES AN ADMIN SCREEN MUST BE ABLE TO SAY.
//
//   "I could not read this."      — a read failed, so the figure is unknown.
//   "This is not all of it."      — a read hit its ceiling, so the figure is a
//                                   floor.
//
// Neither had anywhere to be said. Failed reads were substituted with zeros,
// and every reporting module computed a `truncated` flag that no screen in the
// application rendered — including the sales-tax report the owner files from.
//
// Server components: no state, no interactivity, and they must render inside
// server pages without pulling a client bundle in behind them.
// ---------------------------------------------------------------------------

/**
 * Names the reads that did not answer, so a "—" on the page has an explanation
 * beside it. Renders nothing when everything loaded.
 */
export function AdminReadFailureNotice({ failures }: { failures: readonly string[] }) {
  if (failures.length === 0) return null;

  return (
    <div
      role="alert"
      className="rounded-2xl border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100"
    >
      <p>
        <strong>Some figures on this page could not be loaded.</strong> They are shown as
        {" — "}
        rather than as zero, because this screen does not know what they are. Nothing below is
        evidence that the store is quiet.
      </p>
      <p className="mt-1 text-[13px] text-rose-200/90">
        Did not load: {failures.join(", ")}. Reload; if it persists, check the database connection
        before acting on anything here.
      </p>
    </div>
  );
}

/**
 * Says that a figure is a floor rather than a total, because the read stopped
 * at its ceiling before the data ran out.
 */
export function AdminTruncationNotice({
  sources,
  detail,
}: {
  sources: readonly string[];
  detail?: string;
}) {
  if (sources.length === 0) return null;

  return (
    <div
      role="alert"
      className="rounded-2xl border border-amber-300/40 bg-amber-300/10 px-4 py-3 text-sm text-amber-100"
    >
      <p>
        <strong>Incomplete: these are floors, not totals.</strong> The store holds more rows than one
        read returns, so {sources.join(" and ")} {sources.length === 1 ? "covers" : "cover"} part of
        the history and the real figure is higher.
      </p>
      {detail ? <p className="mt-1 text-[13px] text-amber-200/90">{detail}</p> : null}
    </div>
  );
}
