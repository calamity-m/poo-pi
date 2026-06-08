/**
 * Compact numeric formatters shared by the context report and the status footer
 * so the two surfaces render token counts and percentages identically.
 */

/** Format a percentage compactly, using one decimal only for small fractional values. */
export function formatPercent(percent: number | null): string {
  if (percent === null) return "?";
  return `${percent < 10 && percent % 1 !== 0 ? percent.toFixed(1) : Math.round(percent)}%`;
}

/** Format a token count compactly with k/M suffixes for large values. */
export function formatTokens(count: number | null): string {
  if (count === null) return "?";
  if (count < 1000) return String(Math.round(count));
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}
