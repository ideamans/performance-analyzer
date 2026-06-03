import { buildRequests } from './network/requests.js'
import { buildTimeline } from './trace/markers.js'
import { buildMainThreadTasks, getTopLevelTasks } from './trace/mainthread.js'
import { buildLongTasks } from './trace/longtasks.js'
import type { Artifacts, Derived, LighthouseAudit } from './types.js'

/**
 * Build the normalized derived model from raw artifacts, once per analysis run.
 * All times are ms relative to navigationStart=0 on the observed trace clock.
 * Under applied (devtools) throttling the observed clock IS the experienced
 * timeline, so these windows honestly reflect "what happens before FCP/LCP".
 */
export function buildDerived(artifacts: Artifacts): Derived {
  const timeline = buildTimeline(artifacts)
  const requests = buildRequests(artifacts, timeline.largestContentfulPaint)
  const mainThread = buildMainThreadTasks(artifacts)
  const longTasks = buildLongTasks(artifacts)
  const topLevelTasks = getTopLevelTasks(artifacts)
  const interactive = interactiveMs(artifacts)
  return { timeline, requests, mainThread, longTasks, topLevelTasks, interactive }
}

function interactiveMs(artifacts: Artifacts): number | undefined {
  const metrics = artifacts.lhr.audits?.metrics as LighthouseAudit | undefined
  const v = (metrics?.details?.items?.[0] as Record<string, unknown> | undefined)?.interactive
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const audit = artifacts.lhr.audits?.interactive as LighthouseAudit | undefined
  return typeof audit?.numericValue === 'number' && Number.isFinite(audit.numericValue) ? audit.numericValue : undefined
}

export { buildTimeline, buildRequests, buildMainThreadTasks, buildLongTasks, getTopLevelTasks }
