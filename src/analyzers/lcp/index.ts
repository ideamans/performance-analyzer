import type {
  AnalysisResult,
  Artifacts,
  Derived,
  Finding,
  LighthouseAudit,
  LongTask,
  MainThreadCategory,
  MainThreadTask,
  NetworkRequest,
  TraceEvent,
} from '../../core/types.js'
import { overlapDuration, round } from '../../core/time.js'
import { computeBlockingTime } from '../../core/trace/longtasks.js'
import { getMainFrameId } from '../../core/trace/mainthread.js'
import type { Analyzer, AnalyzerContext } from '../Analyzer.js'
import type {
  CountBytes,
  Crp,
  HtmlCss,
  LatencyBreakdown,
  LcpDetail,
  LcpImageCheck,
  LcpImageNetwork,
  LcpImageSize,
  LcpPhase,
  ObstructionGroup,
  MainThreadWindow,
  NetworkWindow,
  LcpData,
} from './types.js'

const SCHEMA_VERSION = '1.0.0'
const ALL_CATEGORIES: MainThreadCategory[] = ['scripting', 'parsing', 'rendering', 'painting', 'gc', 'other']

/** Analyzer 1: what happens / obstructs / is slow on the way to LCP. */
export const lcpAnalyzer: Analyzer<LcpData> = {
  name: 'lcp',
  async analyze(ctx: AnalyzerContext): Promise<AnalysisResult<LcpData>> {
    const { artifacts, derived } = ctx
    const data = buildLcpData(artifacts, derived)
    const findings = buildFindings(data)

    return {
      analyzer: 'lcp',
      schemaVersion: SCHEMA_VERSION,
      url: artifacts.meta.finalUrl ?? artifacts.meta.url,
      device: artifacts.meta.device,
      capturedAt: artifacts.meta.capturedAt,
      summary: {
        ttfbMs: data.timeline.timeToFirstByteMs,
        fcpMs: data.timeline.firstContentfulPaintMs,
        lcpMs: data.timeline.largestContentfulPaintMs,
        tbtMs: data.timeline.totalBlockingTimeMs,
        lcpRenderDelayMs: round(data.lcp.phases.find((p) => /render delay/i.test(p.phase))?.ms),
        networkVerdict: data.latency.verdict,
        lcpImagePrioritized: data.lcp.image ? String(data.lcp.image.prioritizedWell) : 'n/a',
        lcpImageBottleneck: data.lcp.image?.network?.bottleneck ?? 'n/a',
        lcpImageRank: data.crp.lcpImage
          ? `${data.crp.lcpImage.rankAmongImages}/${data.crp.lcpImage.totalImages} images (#${data.crp.lcpImage.rankOverall} overall)`
          : 'n/a',
        obstructorsBeforeImage: data.crp.obstructorsBeforeImageStart.count,
        obstructorsBeforeImageKB: kb(data.crp.obstructorsBeforeImageStart.transferBytes),
        beforeLcpRequests: data.network.toLcp?.total.count,
        beforeLcpBytes: data.network.toLcp?.total.transferBytes,
      },
      data,
      findings,
    }
  },
}

function buildLcpData(artifacts: Artifacts, derived: Derived): LcpData {
  const { timeline, requests, mainThread, longTasks, topLevelTasks } = derived
  const m = artifacts.meta.metrics

  const fcpWin = timeline.firstContentfulPaint
  const lcpWin = timeline.largestContentfulPaint

  // Total Blocking Time, computed from the trace (authoritative; doesn't depend
  // on the metrics audit, which can be NaN for very heavy pages). Standard TBT
  // uses [FCP, TTI]; blockingToLcp uses [FCP, LCP] — more relevant to "before LCP".
  const tbt =
    fcpWin !== undefined && derived.interactive !== undefined
      ? computeBlockingTime(topLevelTasks, fcpWin, derived.interactive)
      : undefined
  const blockingToLcp =
    fcpWin !== undefined && lcpWin !== undefined ? computeBlockingTime(topLevelTasks, fcpWin, lcpWin) : undefined

  const lcpDetail = buildLcpDetail(artifacts, requests)

  const fcp = round(fcpWin)
  const lcp = round(lcpWin)
  const throttleDesc =
    (artifacts.meta.throttling as { description?: string } | undefined)?.description ?? 'applied (DevTools) throttling'
  return {
    basis:
      `Captured with applied (DevTools) throttling [${throttleDesc}], so the ` +
      'recorded trace IS the throttled experience: reported and observed FCP/LCP ' +
      'are equal and every window aggregation (main-thread, network, blocking ' +
      'time) is measured on this single real timeline.',
    timeline: {
      timeToFirstByteMs: round(m.timeToFirstByte),
      firstContentfulPaintMs: fcp,
      largestContentfulPaintMs: lcp,
      observedFcpMs: round(fcpWin),
      observedLcpMs: round(lcpWin),
      domContentLoadedMs: round(timeline.domContentLoaded),
      loadMs: round(timeline.load),
      totalBlockingTimeMs: round(tbt),
      blockingTimeToLcpMs: round(blockingToLcp),
      interactiveMs: round(derived.interactive),
      lcpMinusFcpMs: typeof lcp === 'number' && typeof fcp === 'number' ? lcp - fcp : undefined,
    },
    mainThread: {
      toFcp: fcpWin !== undefined ? aggregateMainThread(mainThread, fcpWin) : undefined,
      toLcp: lcpWin !== undefined ? aggregateMainThread(mainThread, lcpWin) : undefined,
    },
    longTasks: summarizeLongTasks(longTasks, lcpWin),
    network: {
      toFcp: fcpWin !== undefined ? aggregateNetwork(requests, fcpWin) : undefined,
      toLcp: lcpWin !== undefined ? aggregateNetwork(requests, lcpWin) : undefined,
    },
    latency: buildLatency(artifacts, requests, lcpWin),
    htmlCss: buildHtmlCss(requests),
    lcp: lcpDetail,
    crp: buildCrp(artifacts, requests, lcpDetail),
  }
}

// --- 3.B main-thread breakdown -------------------------------------------

function aggregateMainThread(tasks: MainThreadTask[], windowEnd: number): MainThreadWindow {
  const w = { start: 0, end: windowEnd }
  const byCategory = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, { count: 0, ms: 0 }])) as Record<
    MainThreadCategory,
    { count: number; ms: number }
  >
  let busy = 0
  for (const t of tasks) {
    const ms = overlapDuration(t.start, t.start + t.duration, w)
    if (ms <= 0) continue
    byCategory[t.category].ms += ms
    byCategory[t.category].count += 1
    busy += ms
  }
  for (const c of ALL_CATEGORIES) byCategory[c].ms = round(byCategory[c].ms, 1)!
  return {
    windowMs: round(windowEnd)!,
    busyMs: round(busy)!,
    idleMs: round(Math.max(0, windowEnd - busy))!,
    byCategory,
  }
}

// --- 3.C long tasks -------------------------------------------------------

function summarizeLongTasks(longTasks: LongTask[], lcpWin?: number): LcpData['longTasks'] {
  const inWindow = lcpWin === undefined ? longTasks : longTasks.filter((t) => t.start < lcpWin)
  const total = inWindow.reduce((s, t) => s + t.duration, 0)
  const max = inWindow.reduce((mx, t) => Math.max(mx, t.duration), 0)
  const top = [...inWindow]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 5)
    .map((t) => ({ startMs: round(t.start)!, durationMs: round(t.duration)!, url: t.attributableUrl }))
  return { count: inWindow.length, totalMs: round(total)!, maxMs: round(max)!, top }
}

// --- 3.D network breakdown ------------------------------------------------

function aggregateNetwork(requests: NetworkRequest[], windowEnd: number): NetworkWindow {
  const inWindow = requests.filter((r) => r.startTime < windowEnd)
  const total: CountBytes = { count: 0, transferBytes: 0, resourceBytes: 0 }
  const byType: NetworkWindow['byType'] = {}
  const thirdParty: CountBytes = { count: 0, transferBytes: 0, resourceBytes: 0 }
  const byPriority: Record<string, number> = {}

  for (const r of inWindow) {
    add(total, r)
    const t = (byType[r.resourceType] ??= { count: 0, transferBytes: 0, resourceBytes: 0 })
    add(t, r)
    if (r.party === 'third') add(thirdParty, r)
    if (r.priority) byPriority[r.priority] = (byPriority[r.priority] ?? 0) + 1
  }
  return { windowMs: round(windowEnd)!, total, byType, thirdParty, byPriority }
}

function add(acc: CountBytes, r: NetworkRequest): void {
  acc.count += 1
  acc.transferBytes += r.transferSize
  acc.resourceBytes += r.resourceSize
}

// --- 3.D-2 latency decomposition -----------------------------------------

function buildLatency(artifacts: Artifacts, requests: NetworkRequest[], lcpWin?: number): LatencyBreakdown {
  const inWindow = lcpWin === undefined ? requests : requests.filter((r) => r.startTime < lcpWin)
  let setup = 0
  let waiting = 0
  let download = 0
  for (const r of inWindow) {
    setup += r.timing.connectionSetup ?? 0
    waiting += r.timing.waiting ?? 0
    download += r.timing.download ?? 0
  }
  const latencyPart = setup + waiting
  const verdict: LatencyBreakdown['verdict'] =
    download === 0 && latencyPart === 0
      ? 'balanced'
      : latencyPart > download * 1.3
        ? 'latency-bound'
        : download > latencyPart * 1.3
          ? 'bandwidth-bound'
          : 'balanced'

  const worstByWaiting = [...inWindow]
    .filter((r) => (r.timing.waiting ?? 0) > 0)
    .sort((a, b) => (b.timing.waiting ?? 0) - (a.timing.waiting ?? 0))
    .slice(0, 5)
    .map((r) => ({ url: r.url, ms: round(r.timing.waiting) ?? 0 }))
  const worstByDownload = [...inWindow]
    .filter((r) => (r.timing.download ?? 0) > 0)
    .sort((a, b) => (b.timing.download ?? 0) - (a.timing.download ?? 0))
    .slice(0, 5)
    .map((r) => ({ url: r.url, ms: round(r.timing.download) ?? 0, transferBytes: r.transferSize }))

  return {
    connectionSetupMs: round(setup)!,
    waitingMs: round(waiting)!,
    downloadMs: round(download)!,
    verdict,
    worstByWaiting,
    worstByDownload,
    rttByOrigin: originValues(artifacts, 'network-rtt', 'rtt').map((o) => ({ origin: o.origin, rttMs: o.value })),
    serverLatencyByOrigin: originValues(artifacts, 'network-server-latency', 'serverResponseTime').map((o) => ({
      origin: o.origin,
      ms: o.value,
    })),
  }
}

function originValues(artifacts: Artifacts, auditId: string, key: string): Array<{ origin: string; value: number }> {
  const audit = artifacts.lhr.audits?.[auditId] as LighthouseAudit | undefined
  const items = (audit?.details?.items ?? []) as Array<Record<string, unknown>>
  return items
    .map((i) => ({ origin: String(i.origin ?? ''), value: round(Number(i[key])) ?? 0 }))
    .filter((i) => i.origin)
    .slice(0, 8)
}

// --- 3.D-3 HTML / CSS -----------------------------------------------------

function buildHtmlCss(requests: NetworkRequest[]): HtmlCss {
  const doc = requests.find((r) => r.resourceType === 'document')
  const css = requests.filter((r) => r.resourceType === 'stylesheet')
  const cssTransfer = css.reduce((s, r) => s + r.transferSize, 0)
  const cssComplete = css.length > 0 ? Math.max(...css.map((r) => r.endTime)) : undefined

  return {
    htmlTtfbMs: doc ? round((doc.timing.connectionSetup ?? 0) + (doc.timing.waiting ?? 0)) : undefined,
    htmlTransferBytes: doc?.transferSize,
    htmlResourceBytes: doc?.resourceSize,
    htmlDownloadMs: doc ? round(doc.timing.download) : undefined,
    htmlCompleteMs: doc ? round(doc.endTime) : undefined,
    cssCount: css.length,
    cssTransferBytes: cssTransfer,
    cssCompleteMs: round(cssComplete),
  }
}

// --- 3.E LCP detail -------------------------------------------------------

function buildLcpDetail(artifacts: Artifacts, requests: NetworkRequest[]): LcpDetail {
  const phases = lcpPhases(artifacts)
  const candidate = mainFrameLcpCandidate(artifacts)
  const type = candidate?.type
  const isImage = type === 'image'

  let image: LcpImageCheck | undefined
  if (isImage) {
    const paint = resolveLcpImagePaint(artifacts.trace.traceEvents, candidate)
    const req = matchLcpImage(requests, candidate, paint?.url)
    const prioritize = artifacts.lhr.audits?.['prioritize-lcp-image'] as LighthouseAudit | undefined
    const isLazy = candidate?.loadingAttr === 'lazy'
    const highPriority = req?.priority === 'High' || req?.priority === 'VeryHigh'
    // Trust Lighthouse's audit: a passing prioritize-lcp-image means no
    // meaningful preload/priority win is available, even if the initial network
    // priority reads "Low" (Chrome boosts in-viewport LCP images after layout).
    const auditOk = prioritize?.score === 1
    const ttfb = numv(artifacts.lhr.audits?.metrics?.details?.items?.[0]?.['timeToFirstByte'])
    image = {
      url: req?.url,
      networkPriority: req?.priority,
      loadingAttr: candidate?.loadingAttr,
      isLazy,
      discoveryTimeMs: round(candidate?.imageDiscoveryTime),
      loadStartMs: round(candidate?.imageLoadStart),
      loadEndMs: round(candidate?.imageLoadEnd),
      transferBytes: req?.transferSize,
      resourceBytes: req?.resourceSize,
      size: lcpImageSize(req, paint, devicePixelRatio(artifacts)),
      protocol: req?.protocol,
      prioritizedWell: !isLazy && (highPriority || auditOk),
      prioritizeAuditScore: prioritize?.score,
      prioritizeAuditValue: prioritize?.displayValue,
      network: req ? lcpImageNetwork(req, ttfb) : undefined,
    }
  }

  return {
    phases,
    elementType: type,
    elementName: candidate?.nodeName,
    isImage,
    image,
  }
}

/**
 * Decompose the LCP image's path-to-paint into phases and name the bottleneck:
 *   discovery (Load Delay) → connection setup → waiting (TTFB) → download.
 * Uses the request's own timing; loadDelay is request start minus document TTFB.
 */
function lcpImageNetwork(req: NetworkRequest, ttfb?: number): LcpImageNetwork {
  const loadDelay = ttfb !== undefined ? Math.max(0, req.startTime - ttfb) : undefined
  const setup = req.timing.connectionSetup ?? 0
  const waiting = req.timing.waiting ?? 0
  const download = req.timing.download ?? 0

  const candidates: Array<[LcpImageNetwork['bottleneck'], number]> = [
    ['discovery', loadDelay ?? 0],
    ['connection', setup],
    ['waiting', waiting],
    ['download', download],
  ]
  const bottleneck = candidates.reduce((max, c) => (c[1] > max[1] ? c : max))[0]

  return {
    requestStartMs: round(req.startTime),
    requestEndMs: round(req.endTime),
    loadDelayMs: round(loadDelay),
    connectionSetupMs: round(setup),
    dnsMs: round(req.timing.dns),
    connectMs: round(req.timing.connect),
    tlsMs: round(req.timing.tls),
    waitingMs: round(waiting),
    downloadMs: round(download),
    bottleneck,
  }
}

/** LCP image dimensions + how oversized it is vs what the layout needs. */
function lcpImageSize(req: NetworkRequest | undefined, paint: LcpImagePaint | undefined, dpr: number): LcpImageSize {
  const iw = paint?.intrinsicWidth
  const ih = paint?.intrinsicHeight
  const dw = paint?.displayWidth
  const dh = paint?.displayHeight
  const megapixels = iw && ih ? round((iw * ih) / 1_000_000, 2) : undefined

  // Pixels the layout actually needs = display CSS px × DPR, in each dimension.
  let oversizeFactor: number | undefined
  if (iw && ih && dw && dh && dw > 0 && dh > 0) {
    const neededArea = dw * dpr * (dh * dpr)
    if (neededArea > 0) oversizeFactor = round((iw * ih) / neededArea, 2)
  }

  return {
    transferBytes: req?.transferSize,
    resourceBytes: req?.resourceSize,
    displayWidth: round(dw),
    displayHeight: round(dh),
    intrinsicWidth: round(iw),
    intrinsicHeight: round(ih),
    megapixels,
    devicePixelRatio: dpr,
    oversizeFactor,
  }
}

function devicePixelRatio(artifacts: Artifacts): number {
  const cfg = artifacts.lhr.configSettings as { screenEmulation?: { deviceScaleFactor?: number } } | undefined
  const dpr = cfg?.screenEmulation?.deviceScaleFactor
  return typeof dpr === 'number' && dpr > 0 ? dpr : 1
}

function lcpPhases(artifacts: Artifacts): LcpPhase[] {
  const audit = artifacts.lhr.audits?.['largest-contentful-paint-element'] as LighthouseAudit | undefined
  const tables = (audit?.details?.items ?? []) as Array<Record<string, unknown>>
  const phaseTable = tables.find((t) => Array.isArray((t as { items?: unknown }).items) && hasPhase(t))
  const items = ((phaseTable as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [])
  return items.map((i) => ({
    phase: String(i.phase ?? ''),
    ms: round(Number(i.timing)) ?? 0,
    percent: typeof i.percent === 'string' ? i.percent : undefined,
  }))
}

function hasPhase(t: Record<string, unknown>): boolean {
  const items = (t as { items?: Array<Record<string, unknown>> }).items
  return Array.isArray(items) && items.some((i) => typeof i.phase === 'string')
}

interface LcpCandidate {
  type?: string
  nodeName?: string
  nodeId?: number
  frame?: string
  loadingAttr?: string
  imageDiscoveryTime?: number
  imageLoadStart?: number
  imageLoadEnd?: number
}

/**
 * The main frame's LCP candidate, following Lighthouse's isLCPCandidateEvent:
 * an event named largestContentfulPaint::Candidate on the MAIN FRAME, with
 * args.data.size defined (Invalidate events have no size). The final LCP for a
 * frame is its latest valid candidate, so take the one with the greatest ts.
 * (Filtering to the main frame avoids picking an ad-iframe's candidate.)
 */
function mainFrameLcpCandidate(artifacts: Artifacts): LcpCandidate | undefined {
  const mainFrame = getMainFrameId(artifacts)
  const events = artifacts.trace.traceEvents

  let best: TraceEvent | undefined
  for (const e of events) {
    if (e.name !== 'largestContentfulPaint::Candidate') continue
    const frame = str(e.args?.frame)
    if (!frame) continue
    if (mainFrame && frame !== mainFrame) continue
    const data = e.args?.data as Record<string, unknown> | undefined
    if (data?.size === undefined) continue
    if (!best || e.ts > best.ts) best = e
  }
  const data = best?.args?.data as Record<string, unknown> | undefined
  if (!data) return undefined
  return {
    type: str(data.type),
    nodeName: str(data.nodeName),
    nodeId: numv(data.nodeId),
    frame: str(best?.args?.frame),
    loadingAttr: str(data.loadingAttr),
    imageDiscoveryTime: numv(data.imageDiscoveryTime),
    imageLoadStart: numv(data.imageLoadStart),
    imageLoadEnd: numv(data.imageLoadEnd),
  }
}

interface LcpImagePaint {
  url?: string
  displayWidth?: number
  displayHeight?: number
  intrinsicWidth?: number
  intrinsicHeight?: number
}

/**
 * The authoritative LCP image paint: a PaintImage event for the LCP DOM node
 * carries the painted image's url and both its rendered (width/height) and
 * natural (srcWidth/srcHeight) dimensions. (The candidate's `size` is a pixel
 * area, not bytes, so node identity is what links the element to the image.)
 */
function resolveLcpImagePaint(events: TraceEvent[], candidate?: LcpCandidate): LcpImagePaint | undefined {
  if (candidate?.nodeId === undefined) return undefined
  for (const e of events) {
    if (e.name !== 'PaintImage') continue
    const data = e.args?.data as Record<string, unknown> | undefined
    if (numv(data?.nodeId) !== candidate.nodeId) continue
    if (typeof data?.url !== 'string') continue
    return {
      url: data.url,
      displayWidth: numv(data.width),
      displayHeight: numv(data.height),
      intrinsicWidth: numv(data.srcWidth),
      intrinsicHeight: numv(data.srcHeight),
    }
  }
  return undefined
}

/** Match the LCP image to a network request: prefer URL, then load-time proximity. */
function matchLcpImage(
  requests: NetworkRequest[],
  candidate?: LcpCandidate,
  imageUrl?: string,
): NetworkRequest | undefined {
  const images = requests.filter((r) => r.resourceType === 'image')
  if (images.length === 0) return undefined

  if (imageUrl) {
    const byUrl = images.find((r) => r.url === imageUrl)
    if (byUrl) return byUrl
  }

  const target = candidate?.imageLoadStart
  if (target === undefined) {
    return images.reduce((mx, r) => (r.transferSize > (mx?.transferSize ?? -1) ? r : mx), undefined as NetworkRequest | undefined)
  }
  return images.reduce((best, r) => {
    const d = Math.abs(r.startTime - target)
    const bd = best ? Math.abs(best.startTime - target) : Infinity
    return d < bd ? r : best
  }, undefined as NetworkRequest | undefined)
}

// --- 3.G critical rendering path -----------------------------------------

function buildCrp(artifacts: Artifacts, requests: NetworkRequest[], lcp: LcpDetail): Crp {
  const audit = artifacts.lhr.audits?.['critical-request-chains'] as LighthouseAudit | undefined
  const details = audit?.details as Record<string, unknown> | undefined
  const longest = details?.longestChain as Record<string, unknown> | undefined
  const chains = details?.chains as Record<string, unknown> | undefined
  const depth = typeof longest?.length === 'number' ? longest.length : chainDepth(chains)

  const base: Crp = {
    depth,
    longestPathMs: round(numv(longest?.duration)),
    longestPathTransferBytes: numv(longest?.transferSize),
    obstructorsBeforeImageStart: emptyGroup(),
    obstructorsDuringImageLoad: emptyGroup(),
  }

  // Requests are pre-sorted by startTime (see buildRequests).
  const images = requests.filter((r) => r.resourceType === 'image')
  const imgUrl = lcp.image?.url
  const imgReq = imgUrl ? requests.find((r) => r.url === imgUrl) : undefined
  if (!imgReq) return base

  const idxImages = images.findIndex((r) => r === imgReq)
  const idxAll = requests.findIndex((r) => r === imgReq)
  const rankAmongImages = idxImages >= 0 ? idxImages + 1 : 0
  const rankOverall = idxAll >= 0 ? idxAll + 1 : 0

  base.lcpImage = {
    url: imgReq.url,
    rankAmongImages,
    totalImages: images.length,
    rankOverall,
    totalRequests: requests.length,
    imagesBeforeLcp: Math.max(0, rankAmongImages - 1),
    requestStartMs: round(imgReq.startTime)!,
    requestEndMs: round(imgReq.endTime)!,
  }

  // Essential = document + render-blocking stylesheets + the LCP image itself.
  // Everything else is non-essential to getting the LCP pixels painted.
  const essential = (r: NetworkRequest): boolean =>
    r === imgReq || r.resourceType === 'document' || r.resourceType === 'stylesheet'

  const nonEssential = requests.filter((r) => !essential(r))
  const beforeStart = nonEssential.filter((r) => r.startTime < imgReq.startTime)
  const duringLoad = nonEssential.filter((r) => r.startTime < imgReq.endTime && r.endTime > imgReq.startTime)

  base.obstructorsBeforeImageStart = group(beforeStart)
  base.obstructorsDuringImageLoad = group(duringLoad)
  return base
}

function emptyGroup(): ObstructionGroup {
  return { count: 0, transferBytes: 0, top: [] }
}

function group(reqs: NetworkRequest[]): ObstructionGroup {
  const top = [...reqs]
    .sort((a, b) => b.transferSize - a.transferSize)
    .slice(0, 8)
    .map((r) => ({
      url: r.url,
      resourceType: r.resourceType,
      startMs: round(r.startTime)!,
      endMs: round(r.endTime)!,
      transferBytes: r.transferSize,
      priority: r.priority,
      party: r.party,
    }))
  return { count: reqs.length, transferBytes: reqs.reduce((s, r) => s + r.transferSize, 0), top }
}

function chainDepth(chains?: Record<string, unknown>): number {
  if (!chains) return 0
  let max = 0
  const walk = (node: Record<string, unknown>, d: number): void => {
    max = Math.max(max, d)
    const children = node.children as Record<string, unknown> | undefined
    if (children) for (const k of Object.keys(children)) walk(children[k] as Record<string, unknown>, d + 1)
  }
  for (const k of Object.keys(chains)) walk(chains[k] as Record<string, unknown>, 1)
  return max
}

// --- findings -------------------------------------------------------------

function buildFindings(data: LcpData): Finding[] {
  const findings: Finding[] = []
  const img = data.lcp.image

  if (img && img.url && !img.prioritizedWell) {
    findings.push({
      severity: 'warn',
      message: `LCP画像が最優先で読み込まれていません (priority=${img.networkPriority ?? 'n/a'}${img.isLazy ? ', loading=lazy' : ''})`,
      evidence: { url: img.url, priority: img.networkPriority, loadingAttr: img.loadingAttr },
    })
  }

  const sz = img?.size
  if (sz && sz.oversizeFactor !== undefined && sz.oversizeFactor > 1.5) {
    findings.push({
      severity: 'warn',
      message: `LCP画像が過大 (実寸 ${sz.intrinsicWidth}x${sz.intrinsicHeight}px ${sz.megapixels}MP, 表示 ${sz.displayWidth}x${sz.displayHeight}px@DPR${sz.devicePixelRatio} → 約${sz.oversizeFactor}倍の画素)。リサイズで転送量削減`,
      evidence: { intrinsic: [sz.intrinsicWidth, sz.intrinsicHeight], display: [sz.displayWidth, sz.displayHeight], oversizeFactor: sz.oversizeFactor, transferBytes: sz.transferBytes },
    })
  }

  if (img?.network) {
    const n = img.network
    const label: Record<LcpImageNetwork['bottleneck'], string> = {
      discovery: `発見の遅さ (Load Delay ${n.loadDelayMs}ms)。HTML/JSが画像の発見を遅らせている → preload/軽量化`,
      connection: `接続確立 (${n.connectionSetupMs}ms)。preconnect/接続再利用を検討`,
      waiting: `サーバ応答 (TTFB ${n.waitingMs}ms)。サーバ処理/CDNを検討`,
      download: `画像のダウンロード (${n.downloadMs}ms, ${kb(img.transferBytes ?? 0)}KB)。次世代フォーマット/サイズ最適化/帯域競合の削減`,
    }
    findings.push({
      severity: 'info',
      message: `LCP画像のボトルネックは「${n.bottleneck}」: ${label[n.bottleneck]}`,
      evidence: {
        loadDelayMs: n.loadDelayMs,
        connectionSetupMs: n.connectionSetupMs,
        waitingMs: n.waitingMs,
        downloadMs: n.downloadMs,
      },
    })
  }

  const renderDelay = data.lcp.phases.find((p) => /render delay/i.test(p.phase))
  const lcp = data.timeline.largestContentfulPaintMs
  if (renderDelay && lcp && renderDelay.ms > lcp * 0.4) {
    // Attribute the render delay correctly: CPU occupation vs render-blocking
    // resources/network. Compare main-thread busy time before LCP against the
    // render delay — a mostly-idle main thread means the paint waited on
    // network (render-blocking CSS/JS/fonts), not on the CPU.
    const busy = data.mainThread.toLcp?.busyMs ?? 0
    const cpuBound = busy > renderDelay.ms * 0.5
    findings.push({
      severity: 'warn',
      message: cpuBound
        ? `LCPのRender Delayが支配的 (${renderDelay.ms}ms, LCPの${renderDelay.percent ?? '?'})。メインスレッド占有 (busy ${Math.round(busy)}ms) が主因`
        : `LCPのRender Delayが支配的 (${renderDelay.ms}ms, LCPの${renderDelay.percent ?? '?'})。メインスレッドは空いており (busy ${Math.round(busy)}ms)、レンダーブロッキング資源/ネットワーク待ちが主因`,
      evidence: { renderDelayMs: renderDelay.ms, mainThreadBusyToLcpMs: Math.round(busy) },
    })
  }

  const waitAgg = data.latency.connectionSetupMs + data.latency.waitingMs
  const dlAgg = data.latency.downloadMs
  const ratio = dlAgg > 0 ? (waitAgg / dlAgg).toFixed(1) : '∞'
  if (data.latency.verdict === 'latency-bound') {
    findings.push({
      severity: 'info',
      message: `LCPまでの通信はレイテンシー律速 (待ち:DL ≈ ${ratio}:1、各通信の合算比)。サーバー応答/RTTが支配的`,
    })
  } else if (data.latency.verdict === 'bandwidth-bound') {
    findings.push({
      severity: 'info',
      message: `LCPまでの通信は帯域律速 (DL:待ち ≈ ${(dlAgg / Math.max(1, waitAgg)).toFixed(1)}:1、各通信の合算比)。転送量が支配的`,
    })
  }

  const toLcp = data.mainThread.toLcp
  if (toLcp) {
    const scripting = toLcp.byCategory.scripting.ms
    // Heavy JS is a problem on its own terms (absolute time or share of the
    // window) — not only when it outweighs idle time.
    if (scripting > 1000 || (lcp && scripting > lcp * 0.2)) {
      findings.push({
        severity: 'warn',
        message: `LCPまでのJS実行が重い (scripting ${Math.round(scripting)}ms, busy ${Math.round(toLcp.busyMs)}ms / 窓 ${Math.round(toLcp.windowMs)}ms)`,
        evidence: { scriptingMs: Math.round(scripting), busyMs: Math.round(toLcp.busyMs) },
      })
    }
    // Independently, a largely idle main thread means network is the bottleneck.
    if (toLcp.idleMs > toLcp.busyMs && toLcp.idleMs > toLcp.windowMs * 0.4) {
      findings.push({
        severity: 'info',
        message: `LCPまでメインスレッドの待機が大きい (idle ${Math.round(toLcp.idleMs)}ms / 窓 ${Math.round(toLcp.windowMs)}ms)。ネットワーク待ちも要因`,
      })
    }
  }

  // Where the LCP image sits in the request order, and what non-essential
  // resources (not HTML/CSS/LCP image) stretch the path to paint.
  const ci = data.crp.lcpImage
  const net = img?.network
  if (ci) {
    findings.push({
      severity: 'info',
      message: `LCP画像は画像リクエスト中 ${ci.rankAmongImages}/${ci.totalImages} 番目 (全${ci.totalRequests}リクエスト中#${ci.rankOverall})${ci.imagesBeforeLcp > 0 ? `。先に${ci.imagesBeforeLcp}枚の画像が走っている` : ''}`,
      evidence: { rankAmongImages: ci.rankAmongImages, imagesBeforeLcp: ci.imagesBeforeLcp },
    })

    // Only blame "before-image" resources when discovery was ACTUALLY delayed
    // (a large Load Delay). Co-loaded resources that didn't push the image back
    // are reported in `crp` data but not flagged as the cause.
    const before = data.crp.obstructorsBeforeImageStart
    const loadDelay = net?.loadDelayMs ?? 0
    if (loadDelay >= 150 && before.count > 0) {
      findings.push({
        severity: loadDelay >= 500 ? 'warn' : 'info',
        message:
          `LCP画像の発見が ${loadDelay}ms 遅延。発見前に無関係な(HTML/CSS/LCP画像以外)リソースが ` +
          `${before.count}本 / ${kb(before.transferBytes)}KB 先行。主因: ${describeObstructors(before)} ` +
          `→ LCP画像を <link rel=preload> で先出し、または先行リソースを defer すると描画パスが短縮できる`,
        evidence: { loadDelayMs: loadDelay, count: before.count, transferBytes: before.transferBytes, top: before.top.slice(0, 5) },
      })
    } else if (before.count > 0) {
      findings.push({
        severity: 'info',
        message: `LCP画像の発見は速い (Load Delay ${loadDelay}ms)。発見前の先行リソース ${before.count}本/${kb(before.transferBytes)}KB は並走で実害なし`,
      })
    }

    // "During load" competition only matters when download is the bottleneck
    // (with wide bandwidth it usually isn't).
    const during = data.crp.obstructorsDuringImageLoad
    if (during.count > 0 && (net?.bottleneck === 'download' || during.transferBytes > 500 * 1024)) {
      findings.push({
        severity: 'info',
        message: `LCP画像のDL中に ${during.count}本 / ${kb(during.transferBytes)}KB が並走し帯域/接続を競合。主因: ${describeObstructors(during)} → 並走リソースの削減/遅延でDL短縮`,
        evidence: { count: during.count, transferBytes: during.transferBytes, top: during.top.slice(0, 5) },
      })
    }
  }

  const tp = data.network.toLcp?.thirdParty
  if (tp && tp.count > 0) {
    findings.push({
      severity: tp.count > 10 ? 'warn' : 'info',
      message: `LCP前にサードパーティ ${tp.count}本 / ${kb(tp.transferBytes)}KB を読み込み`,
      evidence: { count: tp.count, transferBytes: tp.transferBytes },
    })
  }

  return findings
}

function kb(bytes: number): number {
  return Math.round(bytes / 1024)
}

/** Summarize an obstruction group: byType counts + top single offender. */
function describeObstructors(g: ObstructionGroup): string {
  const byType = new Map<string, number>()
  for (const r of g.top) byType.set(r.resourceType, (byType.get(r.resourceType) ?? 0) + 1)
  const head = g.top[0]
  const headStr = head ? `${shortUrl(head.url)} (${head.resourceType}, ${kb(head.transferBytes)}KB)` : '—'
  const types = [...byType.entries()].map(([t, n]) => `${t}×${n}`).join(', ')
  return `${headStr}${types ? ` [${types}]` : ''}`
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    const file = u.pathname.split('/').filter(Boolean).pop() ?? ''
    return `${u.hostname}/…/${file}`.slice(0, 80)
  } catch {
    return url.slice(0, 80)
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function numv(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
