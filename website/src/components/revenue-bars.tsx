"use client";

interface RevenuePoint {
  label: string;
  value: number;
}

export function RevenueBars({ title, points, colorClass }: { title: string; points: RevenuePoint[]; colorClass?: string }) {
  const maxValue = Math.max(...points.map((point) => point.value), 1);
  const tone = colorClass ?? "from-cyan-300 via-blue-300 to-indigo-300";

  return (
    <div className="vl-panel rounded-2xl p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">{title}</h3>
        <span className="text-xs text-zinc-500">{points.length} points</span>
      </div>
      <div className="flex h-48 items-end gap-1.5 overflow-x-auto pb-1">
        {points.map((point) => {
          const height = `${Math.max(8, (point.value / maxValue) * 100)}%`;
          return (
            <div key={`${point.label}-${point.value}`} className="group flex min-w-8 flex-1 flex-col items-center justify-end gap-1">
              <div className="w-full rounded-t-md bg-zinc-900/80">
                <div
                  className={`w-full rounded-t-md bg-gradient-to-t ${tone} shadow-[0_0_24px_rgba(59,130,246,0.28)] transition-all duration-300 group-hover:brightness-110`}
                  style={{ height }}
                  title={`${point.label}: $${point.value.toFixed(2)}`}
                />
              </div>
              <p className="text-[10px] text-zinc-500">{point.label}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
