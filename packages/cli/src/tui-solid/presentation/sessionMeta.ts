/**
 * Pure formatters for the sessions list's row metadata (`N msgs · 2h ago`).
 * `now` is passed in (not read via `Date.now()`) so these stay pure + testable;
 * the view supplies the clock.
 */

/** A compact "time since" label: `just now`, `5m ago`, `3h ago`, `2d ago`, … */
export const relativeTime = (ts: number, now: number): string => {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 45) return "just now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${Math.max(1, m)}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  const w = Math.floor(d / 7)
  if (w < 5) return `${w}w ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(d / 365)}y ago`
}

/** The right-aligned session-row metadata: `<count> msgs · <relative time>`,
 *  omitting whichever piece is unknown (the in-memory store / a fresh session). */
export const sessionMeta = (
  messageCount: number | undefined,
  updatedAt: number | undefined,
  now: number,
): string => {
  const parts: string[] = []
  if (messageCount !== undefined) parts.push(`${messageCount} msg${messageCount === 1 ? "" : "s"}`)
  if (updatedAt !== undefined) parts.push(relativeTime(updatedAt, now))
  return parts.join(" · ")
}
