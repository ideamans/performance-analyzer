import type { Artifacts, LongTask, TraceEvent } from '../types.js'
import { getTopLevelTasks, mainThreadContext } from './mainthread.js'

const LONG_TASK_MS = 50

/**
 * Long tasks (>50ms) as top-level main-thread schedulable tasks, in observed
 * time (ms from navigationStart). Under applied (devtools) throttling this is
 * the real experienced timeline, so these line up with the metrics.
 */
export function buildLongTasks(artifacts: Artifacts): LongTask[] {
  const ctx = mainThreadContext(artifacts)
  if (!ctx) return []
  const events = artifacts.trace.traceEvents

  return getTopLevelTasks(artifacts)
    .filter((t) => t.duration > LONG_TASK_MS)
    .map((t) => ({
      start: t.start,
      duration: t.duration,
      attributableUrl: attributeUrl(events, ctx.threads, ctx.navStartTs + t.start * 1000, t.duration * 1000),
    }))
}

/**
 * Total Blocking Time: sum over top-level tasks in the [FCP, TTI] window of
 * (taskDuration − 50ms), clipped to the window. Matches Lighthouse's
 * total-blocking-time computed metric. Returns undefined if the window is
 * unknown. `fcp`/`tti` are ms relative to navigationStart.
 */
export function computeBlockingTime(tasks: Array<{ start: number; duration: number }>, fcp: number, tti: number): number {
  let total = 0
  for (const t of tasks) {
    const end = t.start + t.duration
    // Only the part of the task within [fcp, tti] counts.
    const clippedStart = Math.max(t.start, fcp)
    const clippedEnd = Math.min(end, tti)
    const clipped = clippedEnd - clippedStart
    if (clipped <= LONG_TASK_MS) continue
    total += clipped - LONG_TASK_MS
  }
  return total
}

/** Best-effort: the URL of the longest scripting child inside the task. */
function attributeUrl(
  events: TraceEvent[],
  threads: Array<{ pid: number; tid: number }>,
  startTs: number,
  durationUs: number,
): string | undefined {
  const endTs = startTs + durationUs
  let bestUrl: string | undefined
  let bestDur = 0
  for (const e of events) {
    if (!threads.some((t) => t.pid === e.pid && t.tid === e.tid)) continue
    if (e.ts < startTs || e.ts >= endTs) continue
    if (e.name !== 'EvaluateScript' && e.name !== 'FunctionCall' && e.name !== 'v8.compile') continue
    const data = e.args?.data as Record<string, unknown> | undefined
    const url = typeof data?.url === 'string' ? data.url : undefined
    const dur = typeof e.dur === 'number' ? e.dur : 0
    if (url && dur > bestDur) {
      bestDur = dur
      bestUrl = url
    }
  }
  return bestUrl
}
