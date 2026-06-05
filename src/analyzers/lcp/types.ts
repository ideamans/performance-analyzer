import type { MainThreadCategory, ResourceType } from '../../core/types.js'

/** A simple aggregate used for both ms-totals and byte-totals. */
export interface CountMs {
  count: number
  ms: number
}

export interface CountBytes {
  count: number
  transferBytes: number
  resourceBytes: number
}

/** Main-thread breakdown within one window (e.g. [0, LCP]). */
export interface MainThreadWindow {
  windowMs: number
  busyMs: number
  idleMs: number
  byCategory: Record<MainThreadCategory, CountMs>
}

/** Network breakdown within one window (requests that started before window end). */
export interface NetworkWindow {
  windowMs: number
  total: CountBytes
  byType: Partial<Record<ResourceType, CountBytes>>
  thirdParty: CountBytes
  byPriority: Record<string, number>
}

/** Latency-bound vs bandwidth-bound split (summed over requests before LCP). */
export interface LatencyBreakdown {
  connectionSetupMs: number
  waitingMs: number
  downloadMs: number
  verdict: 'latency-bound' | 'bandwidth-bound' | 'balanced'
  worstByWaiting: Array<{ url: string; ms: number }>
  worstByDownload: Array<{ url: string; ms: number; transferBytes: number }>
  rttByOrigin: Array<{ origin: string; rttMs: number }>
  serverLatencyByOrigin: Array<{ origin: string; ms: number }>
}

export interface HtmlCss {
  htmlTtfbMs?: number
  htmlTransferBytes?: number
  htmlResourceBytes?: number
  htmlDownloadMs?: number
  htmlCompleteMs?: number
  cssCount: number
  cssTransferBytes: number
  cssCompleteMs?: number
}

export interface LcpPhase {
  phase: string
  ms: number
  percent?: string
}

/** The LCP image's network timeline, phase by phase (ms). */
export interface LcpImageNetwork {
  /** Request start / end, navigation-relative. */
  requestStartMs?: number
  requestEndMs?: number
  /** Discovery: time from TTFB to when the image request starts (≈ LH Load Delay). */
  loadDelayMs?: number
  /** Stall + DNS + connect + TLS before bytes are sent. */
  connectionSetupMs?: number
  dnsMs?: number
  connectMs?: number
  tlsMs?: number
  /** TTFB of the image: request sent → first response byte (server + RTT). */
  waitingMs?: number
  /** First byte → finished (transfer over the wire). */
  downloadMs?: number
  /** Which phase dominates the path to the image being painted. */
  bottleneck: 'discovery' | 'connection' | 'waiting' | 'download'
}

/** LCP image dimensions and over-sizing (pixels). */
export interface LcpImageSize {
  /** Bytes over the wire. */
  transferBytes?: number
  /** Decoded resource bytes. */
  resourceBytes?: number
  /** Rendered (CSS px) size on the page. */
  displayWidth?: number
  displayHeight?: number
  /** Natural/intrinsic size of the image file (px). */
  intrinsicWidth?: number
  intrinsicHeight?: number
  /** Intrinsic megapixels. */
  megapixels?: number
  devicePixelRatio?: number
  /**
   * Intrinsic pixel area ÷ pixels actually needed (display × DPR)². >1 means
   * the image is larger than required (wasted bytes); <1 means it's upscaled.
   */
  oversizeFactor?: number
}

export interface LcpImageCheck {
  url?: string
  networkPriority?: string
  loadingAttr?: string
  isLazy?: boolean
  discoveryTimeMs?: number
  loadStartMs?: number
  loadEndMs?: number
  transferBytes?: number
  resourceBytes?: number
  size?: LcpImageSize
  protocol?: string
  prioritizedWell: boolean
  prioritizeAuditScore?: number | null
  prioritizeAuditValue?: string
  /** Network phase timeline + bottleneck. */
  network?: LcpImageNetwork
}

export interface LcpDetail {
  /** Lighthouse 4-phase decomposition (simulated scale on mobile). */
  phases: LcpPhase[]
  elementType?: string
  elementName?: string
  isImage: boolean
  image?: LcpImageCheck
}

/** A single resource on (or obstructing) the critical path. */
export interface CriticalResource {
  url: string
  resourceType: ResourceType
  startMs: number
  endMs: number
  transferBytes: number
  priority?: string
  party: 'first' | 'third'
}

/** A group of obstructing resources with totals and a ranked sample. */
export interface ObstructionGroup {
  count: number
  transferBytes: number
  /** Top offenders, ranked by transfer bytes. */
  top: CriticalResource[]
}

/**
 * A critical-path resource (HTML document, render-blocking CSS/JS, or the LCP
 * image) with its fetch decomposed, so a slow critical fetch is obvious:
 * connection latency (DNS/connect/TLS) vs server wait (TTFB) vs download (size).
 */
export interface CrpResource {
  role: 'document' | 'stylesheet' | 'script' | 'lcp-image'
  url: string
  host: string
  party: 'first' | 'third'
  transferBytes: number
  resourceBytes: number
  startMs: number
  endMs: number
  totalMs: number
  dnsMs?: number
  connectMs?: number
  tlsMs?: number
  /** Stall + DNS + connect + TLS before bytes are sent. */
  connectionSetupMs?: number
  /** TTFB: request sent → first byte (server think + RTT). */
  waitingMs?: number
  /** First byte → finished (transfer over the wire). */
  downloadMs?: number
  /** True when the fetch paid a new-connection handshake (DNS/connect/TLS). */
  newConnection: boolean
  /** Which phase dominated this resource's fetch. */
  bottleneck: 'connection' | 'waiting' | 'download'
}

export interface Crp {
  /** critical-request-chains depth / longest path (Lighthouse). */
  depth: number
  longestPathMs?: number
  longestPathTransferBytes?: number

  /**
   * Each critical-path resource with its fetch broken down (latency / wait /
   * download / size). Sorted by total fetch time, slowest first.
   */
  resources: CrpResource[]
  /** Distinct origins on the critical path (each new origin = a handshake). */
  crpOrigins: number

  /** Where the LCP image sits in the request order. */
  lcpImage?: {
    url: string
    /** 1-based position among image requests, ordered by start time. */
    rankAmongImages: number
    totalImages: number
    /** 1-based position among ALL requests, ordered by start time. */
    rankOverall: number
    totalRequests: number
    /** How many images started before the LCP image. */
    imagesBeforeLcp: number
    requestStartMs: number
    requestEndMs: number
  }

  /**
   * "Essential" = document (HTML) + render-blocking stylesheets + the LCP image.
   * Everything else is non-essential to getting the LCP pixels on screen.
   * These groups are the non-essential resources that may stretch the path.
   */
  obstructorsBeforeImageStart: ObstructionGroup // started before the LCP image → may delay its discovery
  obstructorsDuringImageLoad: ObstructionGroup // overlap the image download → compete for bandwidth/connections
}

/**
 * MECE split of a time window into how it was spent (wall-clock):
 *  - cpuMs:        main thread occupied
 *  - networkWaitMs: ≥1 request in flight while the main thread is idle
 *  - deadMs:       neither — truly idle (timer/scheduling stall, throttle gaps)
 * cpuMs + networkWaitMs + deadMs === windowMs.
 */
export interface WindowComposition {
  windowMs: number
  cpuMs: number
  networkWaitMs: number
  deadMs: number
  /** Auxiliary density: cpu / window (0..1). */
  cpuRate: number
}

/** Composition of one LCP phase (observed-clock boundaries). */
export interface PhaseComposition extends WindowComposition {
  phase: string // TTFB | Load Delay | Load Time | Render Delay
}

export interface LcpData {
  basis: string
  timeline: {
    timeToFirstByteMs?: number
    firstContentfulPaintMs?: number
    largestContentfulPaintMs?: number
    observedFcpMs?: number
    observedLcpMs?: number
    domContentLoadedMs?: number
    loadMs?: number
    totalBlockingTimeMs?: number
    blockingTimeToLcpMs?: number
    interactiveMs?: number
    lcpMinusFcpMs?: number
  }
  mainThread: { toFcp?: MainThreadWindow; toLcp?: MainThreadWindow }
  longTasks: {
    count: number
    totalMs: number
    maxMs: number
    top: Array<{ startMs: number; durationMs: number; url?: string }>
  }
  network: { toFcp?: NetworkWindow; toLcp?: NetworkWindow }
  latency: LatencyBreakdown
  htmlCss: HtmlCss
  lcp: LcpDetail
  crp: Crp
  /**
   * How each LCP phase was spent (CPU / network-wait / dead). Fair to compare
   * across sites phase-by-phase even when absolute phase durations differ.
   */
  phaseComposition: PhaseComposition[]
  /** Overall composition of [0, LCP]. */
  compositionToLcp?: WindowComposition
}
