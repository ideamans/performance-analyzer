import type { AnalysisResult, Artifacts, Derived, Finding, LighthouseAudit, NetworkRequest } from '../../core/types.js'
import { round } from '../../core/time.js'
import type { Analyzer, AnalyzerContext } from '../Analyzer.js'
import { addFiring, analyzeContainer, mergeTagTypes } from './analyze.js'
import { parseGtmResource } from './parse.js'
import type { FiringTiming, GtagIds, GtmContainer, GtmData } from './types.js'

const SCHEMA_VERSION = '1.0.0'
const GTM_BASE = 'https://www.googletagmanager.com/gtm.js?id='

/**
 * Analyzer 3: Google Tag Manager bloat. The container bodies aren't in the
 * trace, so we detect container ids from the network and FETCH each gtm.js live
 * to parse its tags/variables/triggers. Persona: someone who wants to put GTM on
 * a diet — how many containers/tags, how much Custom HTML & dead Universal
 * Analytics, what fires on every pageview, and how much traffic/CPU it costs.
 */
export const gtmAnalyzer: Analyzer<GtmData> = {
  name: 'gtm',
  async analyze(ctx: AnalyzerContext): Promise<AnalysisResult<GtmData>> {
    const { artifacts, derived } = ctx
    const data = await buildGtmData(ctx, artifacts, derived)
    const findings = buildFindings(data)

    return {
      analyzer: 'gtm',
      schemaVersion: SCHEMA_VERSION,
      url: artifacts.meta.finalUrl ?? artifacts.meta.url,
      device: artifacts.meta.device,
      capturedAt: artifacts.meta.capturedAt,
      summary: {
        containers: data.totals.containerCount,
        tags: data.totals.tags,
        customHtml: data.totals.customHtml,
        legacyUa: data.totals.legacyUa,
        pausedTags: data.totals.pausedTags,
        variables: data.totals.variables,
        firesOnPageview: data.totals.firesOnPageview,
        ga4Ids: data.gtagIds.ga4.length,
        adsIds: data.gtagIds.ads.length,
        transferKB: kb(data.totals.transferBytes),
        cpuMs: round(data.totals.cpuMs),
        heaviestTagType: data.tagsByType[0]?.label ?? 'n/a',
      },
      data,
      findings,
    }
  },
}

async function buildGtmData(ctx: AnalyzerContext, artifacts: Artifacts, derived: Derived): Promise<GtmData> {
  const ids = detectContainerIds(derived.requests)
  const gtagIds = detectGtagIds(derived.requests)

  const containers = await Promise.all(
    ids.map((c) => fetchAndAnalyze(ctx, c.id, c.url, derived.requests)),
  )

  const parsed = containers.filter((c) => c.fetched)
  const tagsByType = mergeTagTypes(parsed.map((c) => c.tagsByType))
  const firing = parsed.reduce<FiringTiming>(
    (acc, c) => addFiring(acc, c.firing),
    { pageview: 0, domReady: 0, windowLoad: 0, interaction: 0, custom: 0, unknown: 0 },
  )

  const net = gtmNetwork(derived.requests)
  const cpu = gtmEntityCpu(artifacts)

  return {
    basis:
      'Objective (directly parsed): container ids, tag/variable/predicate/rule ' +
      'counts, tag function-type breakdown, paused/Custom-HTML/UA counts, transfer ' +
      'bytes. HEURISTIC / not authoritative: (1) firing timing is reconstructed ' +
      'via __e→predicates→`if` rules and does NOT model blocking/exception ' +
      'triggers or tag sequencing, so pageview counts can be slightly over-stated; ' +
      '(2) per-tag cost is NOT measured — Custom-HTML "heaviness" is a count, not ' +
      'a per-tag time; (3) Custom-HTML vendor domains are text references in the ' +
      'tag body, not confirmed network loads; (4) CPU/blocking is the "Google Tag ' +
      'Manager" entity (gtm.js/gtag scripts only) — the cost of vendors that GTM ' +
      'INJECTS appears under those vendors, so GTM\'s true footprint is larger and ' +
      'distributed. gtm.js is fetched live, so config may differ from capture time.',
    containers,
    gtagIds,
    totals: {
      containerCount: containers.length,
      parsedContainers: parsed.length,
      tags: sum(parsed, (c) => c.tags),
      customHtml: sum(parsed, (c) => c.customHtml),
      legacyUa: sum(parsed, (c) => c.legacyUa),
      pausedTags: sum(parsed, (c) => c.pausedTags),
      variables: sum(parsed, (c) => c.variables),
      rules: sum(parsed, (c) => c.rules),
      firesOnPageview: sum(parsed, (c) => c.firesOnPageview),
      transferBytes: net.transferBytes,
      decodedBytes: net.decodedBytes,
      cpuMs: cpu.cpuMs,
      blockingMs: cpu.blockingMs,
    },
    tagsByType,
    firing,
  }
}

async function fetchAndAnalyze(
  ctx: AnalyzerContext,
  id: string,
  url: string,
  requests: NetworkRequest[],
): Promise<GtmContainer> {
  const net = requests.find((r) => r.url === url)
  const base: GtmContainer = {
    id,
    url,
    fetched: false,
    transferBytes: net?.transferSize,
    decodedBytes: net?.resourceSize,
    tags: 0,
    variables: 0,
    predicates: 0,
    rules: 0,
    customHtml: 0,
    legacyUa: 0,
    pausedTags: 0,
    tagsByType: [],
    firing: { pageview: 0, domReady: 0, windowLoad: 0, interaction: 0, custom: 0, unknown: 0 },
    firesOnPageview: 0,
    customHtmlVendors: [],
  }

  try {
    const res = await ctx.fetch(`${GTM_BASE}${encodeURIComponent(id)}`)
    if (!res.ok) {
      ctx.logger.warn(`GTM ${id}: HTTP ${res.status}`)
      return { ...base, error: `HTTP ${res.status}` }
    }
    const js = await res.text()
    const resource = parseGtmResource(js)
    if (!resource) {
      ctx.logger.warn(`GTM ${id}: could not parse container body`)
      return { ...base, error: 'parse failed' }
    }
    const analyzed = analyzeContainer(id, url, resource)
    return { ...analyzed, transferBytes: net?.transferSize, decodedBytes: net?.resourceSize }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.logger.warn(`GTM ${id}: fetch error ${msg}`)
    return { ...base, error: msg }
  }
}

// --- detection from the network --------------------------------------------

function detectContainerIds(requests: NetworkRequest[]): Array<{ id: string; url: string }> {
  const seen = new Map<string, string>() // id → url
  for (const r of requests) {
    if (!r.url.includes('googletagmanager.com/gtm.js')) continue
    const m = /[?&]id=(GTM-[A-Z0-9]+)/i.exec(r.url)
    if (m && !seen.has(m[1]!.toUpperCase())) seen.set(m[1]!.toUpperCase(), r.url)
  }
  return [...seen.entries()].map(([id, url]) => ({ id, url }))
}

function detectGtagIds(requests: NetworkRequest[]): GtagIds {
  const ids = new Set<string>()
  for (const r of requests) {
    if (!r.url.includes('googletagmanager.com/gtag')) continue
    const m = /[?&]id=([A-Z]+-[A-Z0-9]+)/i.exec(r.url)
    if (m) ids.add(m[1]!.toUpperCase())
  }
  const out: GtagIds = { ga4: [], ads: [], floodlight: [], universalAnalytics: [], other: [] }
  for (const id of ids) {
    if (id.startsWith('G-') || id.startsWith('GT-')) out.ga4.push(id)
    else if (id.startsWith('AW-')) out.ads.push(id)
    else if (id.startsWith('DC-')) out.floodlight.push(id)
    else if (id.startsWith('UA-')) out.universalAnalytics.push(id)
    else out.other.push(id)
  }
  return out
}

function gtmNetwork(requests: NetworkRequest[]): { transferBytes: number; decodedBytes: number } {
  let transferBytes = 0
  let decodedBytes = 0
  for (const r of requests) {
    if (!r.host.endsWith('googletagmanager.com')) continue
    transferBytes += r.transferSize
    decodedBytes += r.resourceSize
  }
  return { transferBytes, decodedBytes }
}

function gtmEntityCpu(artifacts: Artifacts): { cpuMs: number; blockingMs: number } {
  const audit = artifacts.lhr.audits?.['third-party-summary'] as LighthouseAudit | undefined
  const items = (audit?.details?.items ?? []) as Array<Record<string, unknown>>
  const gtm = items.find((i) => i.entity === 'Google Tag Manager')
  return {
    cpuMs: typeof gtm?.mainThreadTime === 'number' ? gtm.mainThreadTime : 0,
    blockingMs: typeof gtm?.blockingTime === 'number' ? gtm.blockingTime : 0,
  }
}

// --- findings (diet-oriented) ----------------------------------------------

function buildFindings(data: GtmData): Finding[] {
  const findings: Finding[] = []
  const t = data.totals

  if (t.containerCount === 0) {
    findings.push({ severity: 'info', message: 'GTM コンテナは検出されませんでした' })
    return findings
  }

  findings.push({
    severity: t.containerCount >= 4 ? 'warn' : 'info',
    message:
      `GTM コンテナ ${t.containerCount}個 (解析成功 ${t.parsedContainers})、` +
      `タグ計 ${t.tags} / 変数 ${t.variables} / 転送 ${kb(t.transferBytes)}KB / CPU ${round(t.cpuMs)}ms`,
    evidence: { containers: data.containers.map((c) => c.id), tags: t.tags },
  })

  if (t.customHtml > 0) {
    findings.push({
      severity: t.customHtml >= 20 ? 'warn' : 'info',
      message: `カスタムHTMLタグ ${t.customHtml}個 (任意JSの注入＝重い/監査困難。ダイエット最優先候補)`,
      evidence: { customHtml: t.customHtml },
    })
  }

  if (t.legacyUa > 0) {
    findings.push({
      severity: 'warn',
      message: `旧Universal Analytics系タグ ${t.legacyUa}個 — UAは計測停止済み。死蔵の可能性大、まず削除候補`,
      evidence: { legacyUa: t.legacyUa },
    })
  }

  if (t.pausedTags > 0) {
    findings.push({
      severity: 'warn',
      message: `停止中(paused)タグ ${t.pausedTags}個 — UIで止めてもコンテナには同梱され配信される死蔵。削除でサイズ削減`,
      evidence: { pausedTags: t.pausedTags },
    })
  }

  if (t.firesOnPageview > 0) {
    findings.push({
      severity: t.firesOnPageview >= 30 ? 'warn' : 'info',
      message: `pageview(全ページ)で発火するタグ ${t.firesOnPageview}個 — 常時かかるコスト。遅延発火に回せないか要検討`,
      evidence: { firesOnPageview: t.firesOnPageview },
    })
  }

  const topTypes = data.tagsByType.slice(0, 5)
  if (topTypes.length > 0) {
    findings.push({
      severity: 'info',
      message: 'タグ種別内訳(上位): ' + topTypes.map((x) => `${x.label} ${x.count}${x.deprecated ? '(非推奨)' : ''}`).join(' / '),
      evidence: { tagsByType: data.tagsByType },
    })
  }

  if (data.gtagIds.universalAnalytics.length > 0) {
    findings.push({
      severity: 'warn',
      message: `gtag経由のUA計測ID ${data.gtagIds.universalAnalytics.length}個 (${data.gtagIds.universalAnalytics.join(', ')}) — 停止済み計測`,
    })
  }

  // Per-container quick view to point at the biggest offender.
  const heaviest = [...data.containers].filter((c) => c.fetched).sort((a, b) => b.tags - a.tags)[0]
  if (heaviest) {
    findings.push({
      severity: 'info',
      message: `最大コンテナ ${heaviest.id}: タグ${heaviest.tags} (カスタムHTML${heaviest.customHtml}/UA${heaviest.legacyUa}) / 変数${heaviest.variables} / pageview発火${heaviest.firesOnPageview}`,
    })
  }

  const failed = data.containers.filter((c) => !c.fetched)
  if (failed.length > 0) {
    findings.push({
      severity: 'info',
      message: `(注) 取得/解析できなかったコンテナ ${failed.length}個: ${failed.map((c) => `${c.id}(${c.error ?? '?'})`).join(', ')}`,
    })
  }

  return findings
}

function sum<T>(arr: T[], f: (x: T) => number): number {
  return arr.reduce((s, x) => s + f(x), 0)
}

function kb(bytes: number): number {
  return Math.round(bytes / 1024)
}

export type { GtmData } from './types.js'
