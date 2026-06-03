import type { Artifacts, LighthouseAudit, Timeline } from '../types.js'

/**
 * Build the timeline used for slicing the trace and network into windows.
 *
 * We capture with applied (DevTools) throttling, so the trace IS the throttled
 * experience and the observed markers equal the reported metrics. We still read
 * the `observed*` fields (the trace-measured moments) so the windows line up
 * exactly with the trace events and the network-requests audit.
 */
export function buildTimeline(artifacts: Artifacts): Timeline {
  const metrics = metricsItem(artifacts)

  const navStart = num(metrics?.observedNavigationStart) ?? 0
  const rel = (v: unknown): number | undefined => {
    const n = num(v)
    return n === undefined ? undefined : n - navStart
  }

  return {
    navigationStart: 0,
    timeToFirstByte: num(metrics?.timeToFirstByte),
    firstPaint: rel(metrics?.observedFirstPaint),
    firstContentfulPaint: rel(metrics?.observedFirstContentfulPaint),
    largestContentfulPaint: rel(metrics?.observedLargestContentfulPaint),
    domContentLoaded: rel(metrics?.observedDomContentLoaded),
    load: rel(metrics?.observedLoad),
    traceEnd: rel(metrics?.observedTraceEnd),
  }
}

function metricsItem(artifacts: Artifacts): Record<string, unknown> | undefined {
  const audit = artifacts.lhr.audits?.metrics as LighthouseAudit | undefined
  const items = audit?.details?.items
  return Array.isArray(items) ? (items[0] as Record<string, unknown>) : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
