import type {
  Artifacts,
  LighthouseAudit,
  LighthouseTaskGroup,
  MainThreadCategory,
  MainThreadTask,
  TraceEvent,
} from '../types.js'

/**
 * Build the main-thread task list with self-time, faithfully following
 * Lighthouse's trace processing (core/lib/tracehouse). Key points that a naive
 * reader gets wrong, all handled here:
 *
 *  - The page's main thread is the renderer process of the MAIN FRAME, found via
 *    TracingStartedInBrowser (not "the busiest CrRendererMain" — that can be an
 *    ad iframe). Cross-process navigation is handled by also reading
 *    FrameCommittedInBrowser.
 *  - Tasks come from BOTH ph:'X' complete events AND ph:'B'/'E' begin/end pairs.
 *  - Self-time = duration − sum(children duration), on a proper parent/child tree.
 *  - Group = exact name→group map (task-groups.js); unknown names INHERIT the
 *    parent's group, else 'other'.
 *
 * Validated against trace_processor SQL and the mainthread-work-breakdown audit.
 */
export function buildMainThreadTasks(artifacts: Artifacts): MainThreadTask[] {
  const ctx = mainThreadContext(artifacts)
  if (!ctx) return []
  const { threads, navStartTs } = ctx
  const traceEndTs = lastTs(artifacts.trace.traceEvents)

  const tasks: MainThreadTask[] = []
  for (const { pid, tid } of threads) {
    const intervals = collectIntervals(artifacts.trace.traceEvents, pid, tid, traceEndTs)
    // Append without spread — these arrays can have hundreds of thousands of
    // entries, which would overflow the call stack via push(...arr).
    for (const t of buildTreeAndAttribute(intervals, navStartTs)) tasks.push(t)
  }
  tasks.sort((a, b) => a.start - b.start)
  return tasks
}

// --- task intervals from X + B/E events -----------------------------------

interface Interval {
  start: number // µs
  end: number // µs
  name: string
}

/** Turn a thread's X and B/E events into [start,end] intervals (µs). */
function collectIntervals(events: TraceEvent[], pid: number, tid: number, traceEndTs: number): Interval[] {
  const own = events.filter((e) => e.pid === pid && e.tid === tid)
  // Sort by ts; for equal ts, open(B) before complete(X) before close(E).
  const order: Record<string, number> = { B: 0, X: 1, E: 2 }
  own.sort((a, b) => a.ts - b.ts || (order[a.ph] ?? 3) - (order[b.ph] ?? 3))

  const intervals: Interval[] = []
  const open: Array<{ name: string; ts: number }> = []
  for (const e of own) {
    if (e.ph === 'X' && typeof e.dur === 'number' && e.dur >= 0) {
      intervals.push({ start: e.ts, end: e.ts + e.dur, name: e.name })
    } else if (e.ph === 'B') {
      open.push({ name: e.name, ts: e.ts })
    } else if (e.ph === 'E') {
      // Close the nearest matching open begin (Chrome nests properly per thread).
      let idx = -1
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i]!.name === e.name) {
          idx = i
          break
        }
      }
      if (idx === -1 && open.length > 0) idx = open.length - 1
      if (idx >= 0) {
        const o = open.splice(idx, 1)[0]!
        // Skip inverted pairs (E before B) from malformed/truncated traces.
        if (e.ts >= o.ts) intervals.push({ start: o.ts, end: e.ts, name: o.name })
      }
    }
  }
  // Unclosed begins run until the end of the trace (skip if past trace end).
  for (const o of open) {
    if (traceEndTs >= o.ts) intervals.push({ start: o.ts, end: traceEndTs, name: o.name })
  }
  return intervals
}

// --- parent/child tree, self-time, group inheritance ----------------------

function buildTreeAndAttribute(intervals: Interval[], navStartTs: number): MainThreadTask[] {
  // Outer before inner: earlier start first, longer first on ties.
  intervals.sort((a, b) => a.start - b.start || b.end - a.end)

  const n = intervals.length
  const selfUs = intervals.map((i) => i.end - i.start)
  const group: LighthouseTaskGroup[] = new Array(n)
  const stack: number[] = []

  for (let i = 0; i < n; i++) {
    const cur = intervals[i]!
    while (stack.length > 0) {
      const top = intervals[stack[stack.length - 1]!]!
      if (top.end <= cur.start) stack.pop()
      else break
    }
    const parentIdx = stack[stack.length - 1]
    if (parentIdx !== undefined) {
      // Subtract the contained portion from the parent's self-time.
      const p = intervals[parentIdx]!
      const overlap = Math.min(cur.end, p.end) - cur.start
      selfUs[parentIdx]! -= Math.max(0, overlap)
    }
    const mapped = NAME_TO_GROUP[cur.name]
    group[i] = mapped ?? (parentIdx !== undefined ? group[parentIdx]! : 'other')
    stack.push(i)
  }

  const tasks: MainThreadTask[] = []
  for (let i = 0; i < n; i++) {
    const self = selfUs[i]!
    if (self <= 0) continue
    const cur = intervals[i]!
    tasks.push({
      category: GROUP_TO_CATEGORY[group[i]!],
      group: group[i]!,
      start: (cur.start - navStartTs) / 1000,
      duration: self / 1000,
      totalDuration: (cur.end - cur.start) / 1000,
      name: cur.name,
      isLongTask: false,
    })
  }
  return tasks
}

// --- top-level scheduler tasks (for long tasks + TBT) ---------------------

/** Names Lighthouse treats as schedulable top-level tasks (TBT basis). */
const SCHEDULABLE_TASKS = new Set([
  'RunTask',
  'ThreadControllerImpl::RunTask',
  'ThreadControllerImpl::DoWork',
  'TaskQueueManager::ProcessTaskFromWorkQueue',
])

export interface TopLevelTask {
  start: number
  duration: number
}

/**
 * Top-level schedulable tasks on the main thread (ms, navigation-relative).
 * These are the unit for long tasks (>50ms) and Total Blocking Time, matching
 * Lighthouse's getMainThreadTopLevelEvents / isScheduleableTask.
 */
export function getTopLevelTasks(artifacts: Artifacts): TopLevelTask[] {
  const ctx = mainThreadContext(artifacts)
  if (!ctx) return []
  const out: TopLevelTask[] = []
  for (const { pid, tid } of ctx.threads) {
    for (const e of artifacts.trace.traceEvents) {
      if (e.pid !== pid || e.tid !== tid) continue
      if (!SCHEDULABLE_TASKS.has(e.name)) continue
      if (typeof e.dur !== 'number' || e.dur <= 0) continue
      out.push({ start: (e.ts - ctx.navStartTs) / 1000, duration: e.dur / 1000 })
    }
  }
  out.sort((a, b) => a.start - b.start)
  return out
}

// --- main-frame thread identification (authoritative) ---------------------

export interface MainThreadCtx {
  threads: Array<{ pid: number; tid: number }>
  navStartTs: number
}

/** Resolve the main-frame renderer thread(s) and navigationStart ts (µs). */
export function mainThreadContext(artifacts: Artifacts): MainThreadCtx | undefined {
  const events = artifacts.trace.traceEvents
  const navStartTs = observedNavigationStartTs(artifacts) ?? firstNavigationStartTs(events)
  if (navStartTs === undefined) return undefined

  const main = findMainFrame(events)
  if (!main) {
    const fallback = findThreadByMarker(events)
    return fallback ? { threads: [fallback], navStartTs } : undefined
  }

  const pids = collectMainFramePids(events, main.frameId, main.pid)
  const threads: Array<{ pid: number; tid: number }> = []
  for (const pid of pids) {
    const tid = findRendererMainTid(events, pid)
    if (tid !== undefined) threads.push({ pid, tid })
  }
  if (threads.length === 0) {
    const fallback = findThreadByMarker(events)
    if (fallback) threads.push(fallback)
  }
  return threads.length > 0 ? { threads, navStartTs } : undefined
}

const ACCEPTABLE_NAV_URL = /^(chrome|https?):/

/** The main frame's frame id (for filtering FCP/LCP candidate events). */
export function getMainFrameId(artifacts: Artifacts): string | undefined {
  return findMainFrame(artifacts.trace.traceEvents)?.frameId
}

/** findMainFrameIds: TracingStartedInBrowser → main frame, with fallbacks. */
function findMainFrame(events: TraceEvent[]): { frameId: string; pid: number } | undefined {
  const startedInBrowser = events.find((e) => e.name === 'TracingStartedInBrowser')
  const frames = (startedInBrowser?.args?.data as { frames?: Array<Record<string, unknown>> } | undefined)?.frames
  if (Array.isArray(frames)) {
    const root = frames.find((f) => !('parent' in f) || f.parent === undefined)
    const frameId = root?.frame
    const pid = root?.processId
    if (typeof frameId === 'string' && typeof pid === 'number') return { frameId, pid }
  }

  const startedInPage = events.find((e) => e.name === 'TracingStartedInPage')
  const pageFrame = (startedInPage?.args?.data as { page?: string } | undefined)?.page
  if (typeof pageFrame === 'string' && typeof startedInPage?.pid === 'number') {
    return { frameId: pageFrame, pid: startedInPage.pid }
  }

  // Last resort: navigationStart of a real http(s) main-frame load.
  const navStart = events.find(
    (e) =>
      e.name === 'navigationStart' &&
      (e.args?.data as { isLoadingMainFrame?: boolean; documentLoaderURL?: string } | undefined)?.isLoadingMainFrame ===
        true &&
      ACCEPTABLE_NAV_URL.test(String((e.args?.data as { documentLoaderURL?: string } | undefined)?.documentLoaderURL ?? '')),
  )
  const frameId = (navStart?.args as { frame?: string } | undefined)?.frame
  if (typeof frameId === 'string' && typeof navStart?.pid === 'number') return { frameId, pid: navStart.pid }
  return undefined
}

/** All renderer pids that hosted the main frame (handles cross-process nav). */
function collectMainFramePids(events: TraceEvent[], frameId: string, initialPid: number): number[] {
  const pids = new Set<number>([initialPid])
  for (const e of events) {
    if (e.name !== 'FrameCommittedInBrowser' && e.name !== 'ProcessReadyInBrowser') continue
    const data = e.args?.data as { frame?: string; processId?: number } | undefined
    if (data?.frame === frameId && typeof data.processId === 'number') pids.add(data.processId)
  }
  return [...pids]
}

/** The CrRendererMain tid for a process (falls back to CrBrowserMain). */
function findRendererMainTid(events: TraceEvent[], pid: number): number | undefined {
  let browserMain: number | undefined
  for (const e of events) {
    if (e.cat !== '__metadata' || e.ph !== 'M' || e.name !== 'thread_name' || e.pid !== pid) continue
    const name = (e.args as { name?: string } | undefined)?.name
    if (name === 'CrRendererMain') return e.tid
    if (name === 'CrBrowserMain') browserMain = e.tid
  }
  return browserMain
}

function findThreadByMarker(events: TraceEvent[]): { pid: number; tid: number } | undefined {
  const marker = events.find(
    (e) => e.name === 'largestContentfulPaint::Candidate' || e.name === 'firstContentfulPaint',
  )
  return marker ? { pid: marker.pid, tid: marker.tid } : undefined
}

function observedNavigationStartTs(artifacts: Artifacts): number | undefined {
  const audit = artifacts.lhr.audits?.metrics as LighthouseAudit | undefined
  const item = audit?.details?.items?.[0] as Record<string, unknown> | undefined
  const ts = item?.observedNavigationStartTs
  return typeof ts === 'number' ? ts : undefined
}

function firstNavigationStartTs(events: TraceEvent[]): number | undefined {
  const nav = events.find((e) => e.name === 'navigationStart' && typeof e.ts === 'number')
  return nav?.ts
}

function lastTs(events: TraceEvent[]): number {
  let max = 0
  for (const e of events) {
    const end = e.ts + (typeof e.dur === 'number' ? e.dur : 0)
    if (end > max) max = end
  }
  return max
}

// --- Lighthouse task-groups.js taxonomy (exact) ---------------------------

const GROUP_EVENTS: Record<LighthouseTaskGroup, string[]> = {
  parseHTML: ['ParseHTML', 'ParseAuthorStyleSheet'],
  styleLayout: ['ScheduleStyleRecalculation', 'UpdateLayoutTree', 'InvalidateLayout', 'Layout'],
  paintCompositeRender: [
    'Animation',
    'HitTest',
    'PaintSetup',
    'Paint',
    'PaintImage',
    'RasterTask',
    'ScrollLayer',
    'UpdateLayer',
    'UpdateLayerTree',
    'CompositeLayers',
    'PrePaint',
  ],
  scriptParseCompile: ['v8.compile', 'v8.compileModule', 'v8.parseOnBackground'],
  scriptEvaluation: [
    'EventDispatch',
    'EvaluateScript',
    'v8.evaluateModule',
    'FunctionCall',
    'TimerFire',
    'FireIdleCallback',
    'FireAnimationFrame',
    'RunMicrotasks',
    'V8.Execute',
  ],
  garbageCollection: [
    'MinorGC',
    'MajorGC',
    'BlinkGC.AtomicPhase',
    'ThreadState::performIdleLazySweep',
    'ThreadState::completeSweep',
    'BlinkGCMarking',
  ],
  other: ['MessageLoop::RunTask', 'TaskQueueManager::ProcessTaskFromWorkQueue', 'ThreadControllerImpl::DoWork'],
}

const NAME_TO_GROUP: Record<string, LighthouseTaskGroup> = (() => {
  const map: Record<string, LighthouseTaskGroup> = {}
  for (const [group, names] of Object.entries(GROUP_EVENTS) as Array<[LighthouseTaskGroup, string[]]>) {
    for (const name of names) map[name] = group
  }
  return map
})()

const GROUP_TO_CATEGORY: Record<LighthouseTaskGroup, MainThreadCategory> = {
  parseHTML: 'parsing',
  styleLayout: 'rendering',
  paintCompositeRender: 'painting',
  scriptParseCompile: 'scripting',
  scriptEvaluation: 'scripting',
  garbageCollection: 'gc',
  other: 'other',
}
