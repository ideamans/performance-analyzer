/** Time/window/host utilities shared across the core and analyzers. */

/** Round to a fixed number of decimals (default 0 → integer ms). */
export function round(ms: number | undefined, decimals = 0): number | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined
  const f = 10 ** decimals
  return Math.round(ms * f) / f
}

/** A half-open time window [start, end) in ms. */
export interface Window {
  start: number
  end: number
}

/** Does an event that runs over [s, e) overlap the window at all? */
export function overlaps(s: number, e: number, w: Window): boolean {
  return e > w.start && s < w.end
}

/** Did a point in time fall inside the window? */
export function within(t: number, w: Window): boolean {
  return t >= w.start && t < w.end
}

/**
 * Portion of a task [s, e) that lies inside the window (ms). Used to attribute
 * main-thread time to a window even when a task straddles the boundary.
 */
export function overlapDuration(s: number, e: number, w: Window): number {
  const lo = Math.max(s, w.start)
  const hi = Math.min(e, w.end)
  return Math.max(0, hi - lo)
}

/** Lowercase hostname from a URL, or '' if unparseable (e.g. data: URLs). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Naive eTLD+1 (registrable domain). Good enough for first/third-party
 * grouping in this tool; not a full public-suffix implementation.
 */
export function registrableDomain(host: string): string {
  const parts = host.split('.').filter(Boolean)
  if (parts.length <= 2) return host
  // Handle common two-level public suffixes (co.uk, com.au, co.jp, ...).
  const twoLevel = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'go', 'or', 'ne'])
  const tld = parts[parts.length - 1]!
  const sld = parts[parts.length - 2]!
  if (tld.length === 2 && twoLevel.has(sld)) {
    return parts.slice(-3).join('.')
  }
  return parts.slice(-2).join('.')
}

/** True if `host` is the same registrable domain as `baseHost` (a subdomain counts). */
export function sameSite(host: string, baseHost: string): boolean {
  if (!host || !baseHost) return false
  return registrableDomain(host) === registrableDomain(baseHost)
}
