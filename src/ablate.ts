/**
 * Tag ablation: measure the page as-is, then measure it again with every
 * third-party tag domain blocked, and subtract.
 *
 * Deliberately crude — this answers "roughly how much is there to win at most?"
 * in two page loads, not "what exactly happens if we remove tag X":
 *   - blocked requests FAIL (ERR_BLOCKED_BY_CLIENT); they are not empty 200s,
 *     so tag error paths may run
 *   - one run per side by default, so small deltas are within run-to-run noise
 *   - the page may visibly break (a tag may be rendering content)
 * Treat the numbers as an UPPER BOUND / reference value.
 */

import path from 'node:path'
import { writeFile } from 'node:fs/promises'

import { capture, type CaptureOptions } from './capture/index.js'
import { classifyResource, measuredRootDomain } from './analyzers/third-party/classify.js'
import { buildRequests } from './core/network/requests.js'
import type { Artifacts, Device, LighthouseAudit } from './core/types.js'

export interface AblateOptions {
  device?: Device
  /** Runs per side (baseline / blocked). Default 1 — this is a quick experiment. */
  runs?: number
  /** Parent directory; baseline/ and blocked/ run dirs are written inside it. */
  outDir: string
  /** Extra patterns to block on top of the detected tag domains. */
  extraBlockPatterns?: string[]
  logLevel?: CaptureOptions['logLevel']
  onLog?: (msg: string) => void
}

/** One side of the experiment. */
export interface AblateSide {
  runDir: string
  performanceScore?: number
  ttfbMs?: number
  fcpMs?: number
  lcpMs?: number
  speedIndexMs?: number
  tbtMs?: number
  cls?: number
  interactiveMs?: number
  /** Total main-thread work (mainthread-work-breakdown audit). */
  cpuMs?: number
  /**
   * Requests that actually loaded. Blocked requests still appear in the trace
   * (statusCode -1, 0 bytes), so they are excluded here — otherwise the blocked
   * side would look like it still made all those requests.
   */
  requests: number
  transferKB: number
  /** Loaded requests classified as third-party tags (0 on the blocked side). */
  tagRequests: number
  /** Requests that failed, including everything the block killed. */
  failedRequests: number
}

export interface AblateDelta {
  metric: string
  unit: 'ms' | 'kb' | 'score' | 'count' | 'cls'
  baseline?: number
  blocked?: number
  /** blocked - baseline (negative = improved, except for score/count). */
  delta?: number
  /** Percent change vs baseline. */
  deltaPct?: number
}

export interface AblateResult {
  schemaVersion: 1
  url: string
  device: Device
  runsPerSide: number
  capturedAt: string
  /** Domains that were blocked, and the patterns derived from them. */
  blocked: { domains: string[]; vendors: string[]; patterns: string[] }
  baseline: AblateSide
  blockedSide: AblateSide
  deltas: AblateDelta[]
  /** Tag requests that still got through (0 = the block worked). */
  leakedTagRequests: number
  basis: string
}

const BASIS =
  'Upper-bound reference value, not a precise prediction: third-party tag domains are blocked at ' +
  'the network layer (requests FAIL rather than returning empty bodies), one run per side by ' +
  'default, and the page may break if a tag renders content. Read it as "at most this much to win". ' +
  'Blocked requests still appear in the trace as failed 0-byte requests; `requests` counts only ' +
  'loaded ones, and `failedRequests` is where the killed ones went.'

/**
 * Capture baseline, derive the tag domains from it, capture again with those
 * domains blocked, and return the difference.
 */
export async function ablate(url: string, opts: AblateOptions): Promise<AblateResult> {
  const device: Device = opts.device ?? 'mobile'
  const runs = Math.max(1, opts.runs ?? 1)
  const baselineDir = path.join(opts.outDir, 'baseline')
  const blockedDir = path.join(opts.outDir, 'blocked')

  opts.onLog?.('[1/2] baseline (tags as-is)')
  const baseline = await capture(url, {
    device,
    runs,
    outDir: baselineDir,
    logLevel: opts.logLevel,
    onLog: opts.onLog,
  })

  const targets = tagBlockTargets(baseline)
  const patterns = [...targets.patterns, ...(opts.extraBlockPatterns ?? [])]
  if (patterns.length === 0) {
    throw new Error('No third-party tags were detected in the baseline — nothing to ablate.')
  }
  opts.onLog?.(`[2/2] blocked (${targets.domains.length} tag domains, ${targets.vendors.length} vendors)`)

  const blocked = await capture(url, {
    device,
    runs,
    outDir: blockedDir,
    blockedUrlPatterns: patterns,
    logLevel: opts.logLevel,
    onLog: opts.onLog,
  })

  const a = side(baseline, baselineDir)
  const b = side(blocked, blockedDir)

  const result: AblateResult = {
    schemaVersion: 1,
    url,
    device,
    runsPerSide: runs,
    capturedAt: new Date().toISOString(),
    blocked: { domains: targets.domains, vendors: targets.vendors, patterns },
    baseline: a,
    blockedSide: b,
    deltas: computeDeltas(a, b),
    leakedTagRequests: b.tagRequests,
    basis: BASIS,
  }

  await writeFile(path.join(opts.outDir, 'ablation.json'), JSON.stringify(result, null, 2), 'utf8')
  return result
}

/**
 * The tag domains observed in a capture, plus URL glob patterns that block them.
 * Reuses the third-party analyzer's classification, so CDN libraries stay in
 * (they are not tags) and Google Fonts is blocked (it is).
 */
export function tagBlockTargets(artifacts: Artifacts): {
  domains: string[]
  vendors: string[]
  patterns: string[]
} {
  const measuredRoot = measuredRootDomain(artifacts.meta.finalUrl ?? artifacts.meta.url)
  const requests = buildRequests(artifacts)

  const hosts = new Set<string>()
  const roots = new Set<string>()
  const vendors = new Set<string>()
  for (const r of requests) {
    if (!r.host) continue
    const c = classifyResource(r.url, r.host, measuredRoot)
    if (c.kind !== 'tag') continue
    hosts.add(r.host)
    if (c.rootDomain) roots.add(c.rootDomain)
    vendors.add(c.entity)
  }

  // Block the exact hosts seen, plus the whole registrable domain by wildcard so
  // sibling hosts that only appear on the second load are caught too.
  const patterns = new Set<string>()
  for (const host of hosts) patterns.add(`*://${host}/*`)
  for (const root of roots) {
    patterns.add(`*://${root}/*`)
    patterns.add(`*://*.${root}/*`)
  }

  return {
    domains: [...hosts].sort(),
    vendors: [...vendors].sort(),
    patterns: [...patterns].sort(),
  }
}

function side(artifacts: Artifacts, runDir: string): AblateSide {
  const m = artifacts.meta.metrics
  const requests = buildRequests(artifacts)
  const measuredRoot = measuredRootDomain(artifacts.meta.finalUrl ?? artifacts.meta.url)

  let tagRequests = 0
  let loaded = 0
  let failed = 0
  let transferBytes = 0
  for (const r of requests) {
    transferBytes += r.transferSize
    // A blocked request is reported as finished with statusCode -1 and 0 bytes.
    if (typeof r.statusCode === 'number' && r.statusCode <= 0) {
      failed++
      continue
    }
    loaded++
    if (r.host && classifyResource(r.url, r.host, measuredRoot).kind === 'tag') tagRequests++
  }

  return {
    runDir,
    performanceScore: performanceScore(artifacts),
    ttfbMs: m.timeToFirstByte,
    fcpMs: m.firstContentfulPaint,
    lcpMs: m.largestContentfulPaint,
    speedIndexMs: m.speedIndex,
    tbtMs: m.totalBlockingTime,
    cls: m.cumulativeLayoutShift,
    interactiveMs: m.interactive,
    cpuMs: numeric(artifacts, 'mainthread-work-breakdown'),
    requests: loaded,
    transferKB: Math.round(transferBytes / 1024),
    tagRequests,
    failedRequests: failed,
  }
}

/** baseline vs blocked, one row per metric. Exported for tests. */
export function computeDeltas(a: AblateSide, b: AblateSide): AblateDelta[] {
  const rows: Array<[string, AblateDelta['unit'], number | undefined, number | undefined]> = [
    ['performanceScore', 'score', a.performanceScore, b.performanceScore],
    ['lcpMs', 'ms', a.lcpMs, b.lcpMs],
    ['fcpMs', 'ms', a.fcpMs, b.fcpMs],
    ['tbtMs', 'ms', a.tbtMs, b.tbtMs],
    ['speedIndexMs', 'ms', a.speedIndexMs, b.speedIndexMs],
    ['interactiveMs', 'ms', a.interactiveMs, b.interactiveMs],
    ['ttfbMs', 'ms', a.ttfbMs, b.ttfbMs],
    ['cls', 'cls', a.cls, b.cls],
    ['cpuMs', 'ms', a.cpuMs, b.cpuMs],
    ['requests', 'count', a.requests, b.requests],
    ['transferKB', 'kb', a.transferKB, b.transferKB],
    ['tagRequests', 'count', a.tagRequests, b.tagRequests],
  ]

  return rows.map(([metric, unit, baseline, blocked]) => {
    // Percentages come from the raw values: dividing an already-rounded delta by
    // a raw baseline produced nonsense like -101% for a CLS that went to zero.
    const raw = baseline !== undefined && blocked !== undefined ? blocked - baseline : undefined
    const deltaPct = raw !== undefined && baseline ? Math.round((raw / baseline) * 1000) / 10 : undefined
    return { metric, unit, baseline: round(baseline), blocked: round(blocked), delta: round(raw), deltaPct }
  })
}

/** Lighthouse performance score as 0..100 (the lhr stores it as 0..1). */
function performanceScore(artifacts: Artifacts): number | undefined {
  const categories = artifacts.lhr.categories as Record<string, { score?: number | null }> | undefined
  const score = categories?.performance?.score
  return typeof score === 'number' ? Math.round(score * 100) : undefined
}

function numeric(artifacts: Artifacts, auditId: string): number | undefined {
  const audit = artifacts.lhr.audits?.[auditId] as LighthouseAudit | undefined
  const v = audit?.numericValue
  return typeof v === 'number' && Number.isFinite(v) ? round(v) : undefined
}

function round(n?: number): number | undefined {
  if (n === undefined) return undefined
  return Math.abs(n) >= 10 ? Math.round(n) : Math.round(n * 1000) / 1000
}
