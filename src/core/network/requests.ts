import type {
  Artifacts,
  DevtoolsLog,
  LighthouseAudit,
  NetworkRequest,
  RequestPriority,
  RequestTiming,
  ResourceType,
} from '../types.js'
import { hostOf, sameSite } from '../time.js'

/**
 * Build the normalized request list. Base data (navigation-relative times,
 * sizes, type, priority, entity) comes from Lighthouse's `network-requests`
 * audit — already aligned to navigationStart=0. Per-request phase timing
 * (connect / waiting / download) is enriched from the DevtoolsLog
 * `Network.responseReceived` `response.timing`, whose offsets are relative to
 * the request itself, so no clock alignment is needed.
 */
export function buildRequests(artifacts: Artifacts, observedLcp?: number): NetworkRequest[] {
  const audit = artifacts.lhr.audits?.['network-requests'] as LighthouseAudit | undefined
  const items = (audit?.details?.items ?? []) as Array<Record<string, unknown>>

  const baseHost = hostOf(artifacts.meta.finalUrl ?? artifacts.meta.url) || hostOf(documentUrl(items))
  const lcp = observedLcp
  const timingByUrl = buildTimingMap(artifacts.devtoolsLog)

  const requests: NetworkRequest[] = []
  for (const it of items) {
    const url = String(it.url ?? '')
    if (!url || url.startsWith('data:')) continue

    const startTime = num(it.networkRequestTime) ?? num(it.rendererStartTime) ?? 0
    const endTime = num(it.networkEndTime) ?? startTime
    const host = hostOf(url)
    const transferSize = num(it.transferSize) ?? 0
    const resourceSize = num(it.resourceSize) ?? 0

    const rawTiming = takeTiming(timingByUrl, url)
    const timing = decomposeTiming(rawTiming, startTime, endTime)

    requests.push({
      url,
      host,
      resourceType: normalizeResourceType(String(it.resourceType ?? '')),
      mimeType: typeof it.mimeType === 'string' ? it.mimeType : undefined,
      priority: normalizePriority(it.priority),
      protocol: typeof it.protocol === 'string' ? it.protocol : undefined,
      statusCode: num(it.statusCode),
      startTime,
      endTime,
      transferSize,
      resourceSize,
      finished: it.finished !== false,
      fromMainFrame: typeof it.experimentalFromMainFrame === 'boolean' ? it.experimentalFromMainFrame : undefined,
      entity: typeof it.entity === 'string' ? it.entity : undefined,
      timing,
      beforeLCP: typeof lcp === 'number' ? startTime < lcp : false,
      party: baseHost && sameSite(host, baseHost) ? 'first' : 'third',
    })
  }

  requests.sort((a, b) => a.startTime - b.startTime)
  return requests
}

function documentUrl(items: Array<Record<string, unknown>>): string {
  const doc = items.find((i) => String(i.resourceType) === 'Document')
  return doc ? String(doc.url ?? '') : ''
}

/** Raw response.timing object from CDP (offsets in ms relative to requestTime). */
interface RawTiming {
  dnsStart?: number
  dnsEnd?: number
  connectStart?: number
  connectEnd?: number
  sslStart?: number
  sslEnd?: number
  sendStart?: number
  sendEnd?: number
  receiveHeadersStart?: number
  receiveHeadersEnd?: number
}

/**
 * Collect response.timing per URL, in arrival order, so duplicate-URL requests
 * can be matched positionally to the audit's items.
 */
function buildTimingMap(devtoolsLog: DevtoolsLog): Map<string, RawTiming[]> {
  const map = new Map<string, RawTiming[]>()
  for (const entry of devtoolsLog) {
    if (entry.method !== 'Network.responseReceived') continue
    const params = entry.params as Record<string, unknown> | undefined
    const response = params?.response as Record<string, unknown> | undefined
    const url = typeof response?.url === 'string' ? response.url : undefined
    const timing = response?.timing as RawTiming | undefined
    if (!url || !timing) continue
    const list = map.get(url) ?? []
    list.push(timing)
    map.set(url, list)
  }
  return map
}

function takeTiming(map: Map<string, RawTiming[]>, url: string): RawTiming | undefined {
  const list = map.get(url)
  if (!list || list.length === 0) return undefined
  return list.shift()
}

/**
 * Split a request into latency-bound (setup + waiting) vs bandwidth-bound
 * (download) phases. Offsets in `raw` are ms from the request's own start;
 * `start`/`end` are navigation-relative ms used for the total span.
 */
function decomposeTiming(raw: RawTiming | undefined, start: number, end: number): RequestTiming {
  const total = Math.max(0, end - start)
  if (!raw) {
    // No CDP timing — treat the whole span as download-ish (unknown split).
    return { download: total }
  }

  const dns = span(raw.dnsStart, raw.dnsEnd)
  const connect = span(raw.connectStart, raw.connectEnd)
  const tls = span(raw.sslStart, raw.sslEnd)

  const sendStart = pos(raw.sendStart)
  const sendEnd = pos(raw.sendEnd) ?? sendStart
  const firstByte = pos(raw.receiveHeadersStart) ?? pos(raw.receiveHeadersEnd)

  const connectionSetup = sendStart !== undefined ? Math.max(0, sendStart) : undefined

  let waiting: number | undefined
  let download: number | undefined
  if (firstByte !== undefined) {
    const afterSend = sendEnd ?? 0
    waiting = Math.max(0, firstByte - afterSend)
    download = Math.max(0, total - firstByte)
  } else {
    download = total
  }

  return { connectionSetup, dns, connect, tls, waiting, download }
}

/** A positive duration between two offsets, or undefined if not measured. */
function span(a?: number, b?: number): number | undefined {
  if (typeof a !== 'number' || typeof b !== 'number') return undefined
  if (a < 0 || b < 0 || b <= a) return undefined
  return b - a
}

function pos(n?: number): number | undefined {
  return typeof n === 'number' && n >= 0 ? n : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function normalizeResourceType(t: string): ResourceType {
  switch (t) {
    case 'Document':
      return 'document'
    case 'Script':
      return 'script'
    case 'Stylesheet':
      return 'stylesheet'
    case 'Image':
      return 'image'
    case 'Font':
      return 'font'
    case 'Media':
      return 'media'
    case 'XHR':
    case 'Fetch':
    case 'EventSource':
    case 'WebSocket':
      return 'xhr'
    default:
      return 'other'
  }
}

function normalizePriority(p: unknown): RequestPriority | undefined {
  if (typeof p !== 'string') return undefined
  const known: RequestPriority[] = ['VeryHigh', 'High', 'Medium', 'Low', 'VeryLow']
  return known.includes(p as RequestPriority) ? (p as RequestPriority) : undefined
}
