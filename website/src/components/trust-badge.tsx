const ICONS = {
  flask: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M9 2h6M10 2v6.2a2 2 0 0 1-.34 1.12L4.9 17.2A2.4 2.4 0 0 0 6.9 21h10.2a2.4 2.4 0 0 0 2-3.8l-4.76-7.88A2 2 0 0 1 14 8.2V2" />
      <path d="M7.5 15h9" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  truck: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M2 8h11v8H2z" />
      <path d="M13 11h4l4 3v2h-8z" />
      <circle cx="6.5" cy="18.5" r="1.6" />
      <circle cx="17" cy="18.5" r="1.6" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.4 2.4L16 9.6" />
    </svg>
  ),
} as const;

export type TrustBadgeIcon = keyof typeof ICONS;

export function TrustBadge({
  icon,
  label,
  detail,
  className = "",
}: {
  icon: TrustBadgeIcon;
  label: string;
  detail?: string;
  className?: string;
}) {
  return (
    <div className={`vl-badge-trust ${className}`}>
      <span className="vl-badge-trust-icon" aria-hidden="true">
        {ICONS[icon]}
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold uppercase tracking-[0.1em] text-zinc-100">{label}</span>
        {detail ? <span className="block truncate text-[11px] text-zinc-500">{detail}</span> : null}
      </span>
    </div>
  );
}
