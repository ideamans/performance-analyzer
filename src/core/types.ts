/**
 * Core data model shared across capture and analyzers.
 * See architecture.md §3 for the design.
 */

export type Device = 'mobile' | 'desktop'

/** A single Chrome trace event (loose; analyzers narrow as needed). */
export interface TraceEvent {
  pid: number
  tid: number
  ts: number
  ph: string
  cat?: string
  name: string
  dur?: number
  args?: Record<string, unknown>
  [key: string]: unknown
}

/** Chrome trace artifact ({ traceEvents, metadata }). */
export interface Trace {
  traceEvents: TraceEvent[]
  metadata?: Record<string, unknown>
}

/** A single DevTools protocol log entry (CDP message). */
export interface DevtoolsLogEntry {
  method: string
  params?: Record<string, unknown>
  [key: string]: unknown
}

export type DevtoolsLog = DevtoolsLogEntry[]

/** Metadata describing how a capture was produced. */
export interface CaptureMeta {
  url: string
  /** Final URL after redirects (what was actually measured). */
  finalUrl?: string
  device: Device
  /** Throttling settings used (kept for fair cross-site comparison). */
  throttling: {
    method?: string
    [key: string]: unknown
  }
  /**
   * User agent emulated during capture. Recorded because sites can serve
   * different pages per UA, so a dataset is only comparable if this matches.
   */
  userAgent?: string
  /** ISO timestamp of when this run was captured. */
  capturedAt: string
  lighthouseVersion: string
  /** Number of runs performed before selecting the representative one. */
  runs: number
  /** Index (0-based) of the selected representative run among all runs. */
  selectedRunIndex: number
  /** Key metrics (ms) of the selected run, for quick reference. */
  metrics: KeyMetrics
  /**
   * Present only for an ablation variant: the URL patterns that were blocked
   * during the run. Its presence marks this run as NOT a normal capture.
   */
  blockedUrlPatterns?: string[]
}

/** Headline metrics extracted from a Lighthouse run (milliseconds). */
export interface KeyMetrics {
  timeToFirstByte?: number
  firstContentfulPaint?: number
  largestContentfulPaint?: number
  speedIndex?: number
  totalBlockingTime?: number
  cumulativeLayoutShift?: number
  interactive?: number
}

/**
 * Everything an analyzer needs as input. Persisted as one directory per run.
 * See store.ts for the on-disk layout.
 */
export interface Artifacts {
  meta: CaptureMeta
  trace: Trace
  devtoolsLog: DevtoolsLog
  /** Lighthouse Result object (lhr) — for cross-checking computed audits. */
  lhr: LighthouseResult
}

/** Minimal shape of the Lighthouse result we rely on. */
export interface LighthouseResult {
  lighthouseVersion: string
  requestedUrl?: string
  finalDisplayedUrl?: string
  finalUrl?: string
  fetchTime?: string
  audits: Record<string, LighthouseAudit>
  [key: string]: unknown
}

export interface LighthouseAudit {
  id: string
  score: number | null
  numericValue?: number
  displayValue?: string
  details?: {
    items?: Array<Record<string, unknown>>
    [key: string]: unknown
  }
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Derived model — normalized data the core builds from trace + devtoolsLog so
// analyzers don't touch raw artifacts. See architecture.md §3.2.
// ---------------------------------------------------------------------------

/** Headline moments on the timeline, all in ms relative to navigationStart=0. */
export interface Timeline {
  /** Always 0 — kept explicit so windows read naturally as [0, fcp] etc. */
  navigationStart: number
  timeToFirstByte?: number
  firstPaint?: number
  firstContentfulPaint?: number
  largestContentfulPaint?: number
  domContentLoaded?: number
  load?: number
  /** End of the trace, useful as an upper bound for "after LCP" windows. */
  traceEnd?: number
}

export type ResourceType = 'document' | 'script' | 'stylesheet' | 'image' | 'font' | 'media' | 'xhr' | 'other'

export type RequestPriority = 'VeryHigh' | 'High' | 'Medium' | 'Low' | 'VeryLow'

/** Per-request timing phases (ms). Splits latency-bound vs bandwidth-bound. */
export interface RequestTiming {
  /** Everything before the request bytes are sent: stall + DNS + connect + TLS. */
  connectionSetup?: number
  dns?: number
  connect?: number
  tls?: number
  /** Send start → first response byte (server think time + RTT). */
  waiting?: number
  /** First response byte → finished (transfer size ÷ bandwidth). */
  download?: number
}

/** One network request, normalized and navigation-relative (ms). */
export interface NetworkRequest {
  url: string
  host: string
  resourceType: ResourceType
  mimeType?: string
  priority?: RequestPriority
  protocol?: string
  statusCode?: number
  /** Network request start (ms from navigationStart). */
  startTime: number
  /** Network end / finished (ms from navigationStart). */
  endTime: number
  /** Bytes over the wire (compressed). */
  transferSize: number
  /** Decoded resource size. */
  resourceSize: number
  finished: boolean
  fromMainFrame?: boolean
  /** third-party-web entity name, when Lighthouse resolved one. */
  entity?: string
  timing: RequestTiming
  /** Did this request start before LCP? (auxiliary split) */
  beforeLCP: boolean
  /** Whether the host is the first party (measured site's eTLD+1). */
  party: 'first' | 'third'
}

export type MainThreadCategory = 'scripting' | 'parsing' | 'rendering' | 'painting' | 'gc' | 'other'

/** Lighthouse's task-group ids (core/lib/tracehouse/task-groups.js). */
export type LighthouseTaskGroup =
  | 'parseHTML'
  | 'styleLayout'
  | 'paintCompositeRender'
  | 'scriptParseCompile'
  | 'scriptEvaluation'
  | 'garbageCollection'
  | 'other'

/**
 * One main-thread task with its self-time (own duration minus children's),
 * ms relative to navigationStart. `duration` is the self-time used for
 * category aggregation; `totalDuration` is the wall-clock span of the task.
 */
export interface MainThreadTask {
  category: MainThreadCategory
  group: LighthouseTaskGroup
  start: number
  /** Self-time (own time excluding children), ms. */
  duration: number
  /** Wall-clock duration of the task including children, ms. */
  totalDuration: number
  name: string
  isLongTask: boolean
}

/** A long task (>50ms) on the main thread. */
export interface LongTask {
  start: number
  duration: number
  attributableUrl?: string
}

/** A top-level schedulable main-thread task (ms, navigation-relative). */
export interface TopLevelTask {
  start: number
  duration: number
}

/** Everything the core hands to analyzers. */
export interface Derived {
  timeline: Timeline
  requests: NetworkRequest[]
  mainThread: MainThreadTask[]
  longTasks: LongTask[]
  /** Top-level scheduler tasks — the basis for long tasks and TBT. */
  topLevelTasks: TopLevelTask[]
  /** Time to Interactive (ms, navigation-relative), if Lighthouse computed it. */
  interactive?: number
}

// ---------------------------------------------------------------------------
// Analysis result model — what analyzers return and reporters render.
// See architecture.md §4.1 / §5.
// ---------------------------------------------------------------------------

export interface Finding {
  severity: 'info' | 'warn' | 'critical'
  message: string
  evidence?: Record<string, unknown>
}

export interface AnalysisResult<R = unknown> {
  analyzer: string
  schemaVersion: string
  url: string
  device: Device
  capturedAt: string
  /** Top-level summary, for reading sites side by side. */
  summary: Record<string, number | string | undefined>
  data: R
  findings: Finding[]
}
