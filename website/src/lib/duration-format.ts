/**
 * A short, human duration label for the live-visitor dashboard — "42s",
 * "3m", "1h 5m". Not locale-aware, not exhaustive; this is a dashboard
 * badge, not a shopper-facing date.
 */
export function formatDurationShort(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}
