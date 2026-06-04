import type { AnalysisResult, Artifacts, Derived, Finding, LighthouseAudit, NetworkRequest } from '../../core/types.js'
import { round } from '../../core/time.js'
import type { Analyzer, AnalyzerContext } from '../Analyzer.js'
import { addFiring, analyzeContainer, mergeKeyCounts } from './analyze.js'
import { parseGtmContainer } from './parse.js'
import type { FiringTiming, GtagIds, GtmContainer, GtmData, KeyCount, TagTypeCount } from './types.js'

const SCHEMA_VERSION = '2.0.0'
const GTM_BASE = 'https://www.googletagmanager.com/gtm.js?id='

/**
 * Analyzer 3: an OBJECTIVE overview of GTM bloat. Container bodies aren't in the
 * trace, so container ids are detected from the network and each gtm.js is
 * fetched live and parsed (AST). Answers, at a glance: how many containers/tags,
 * what kinds of tags, what they're FOR (vendor attribution by config domain /
 * template type), and what fires on every pageview. Detailed cost lives in the
 * third-party analyzer.
 */
export const gtmAnalyzer: Analyzer<GtmData> = {
  name: 'gtm',
  async analyze(ctx: AnalyzerContext): Promise<AnalysisResult<GtmData>> {
    const { artifacts, derived } = ctx
    const data = await buildGtmData(ctx, artifacts, derived)
    const findings = buildFindings(data)
    const topVendor = data.tagsByVendor.find((v) => v.key !== '(未帰属)')

    return {
      analyzer: 'gtm',
      schemaVersion: SCHEMA_VERSION,
      url: artifacts.meta.finalUrl ?? artifacts.meta.url,
      device: artifacts.meta.device,
      capturedAt: artifacts.meta.capturedAt,
      summary: {
        containers: data.totals.containerCount,
        tags: data.totals.tags,
        firingTags: data.totals.tagClass.firing,
        controlTags: data.totals.tagClass.control,
        customHtml: data.totals.customHtml,
        legacyUa: data.totals.legacyUa,
        pausedTags: data.totals.pausedTags,
        variables: data.totals.variables,
        firesOnPageview: data.totals.firesOnPageview,
        transferKB: kb(data.totals.transferBytes),
        cpuMs: round(data.totals.cpuMs),
        topVendor: topVendor?.key ?? 'n/a',
        topVendorTags: topVendor?.count ?? 0,
        topTagType: data.tagsByType[0]?.label ?? 'n/a',
      },
      data,
      findings,
    }
  },
}

async function buildGtmData(ctx: AnalyzerContext, artifacts: Artifacts, derived: Derived): Promise<GtmData> {
  const ids = detectContainerIds(derived.requests)
  const gtagIds = detectGtagIds(derived.requests)

  const containers = await Promise.all(ids.map((c) => fetchAndAnalyze(ctx, c.id, c.url, derived.requests)))
  const parsed = containers.filter((c) => c.fetched)

  const tagsByType = mergeKeyCounts<TagTypeCount>(
    parsed.map((c) => c.tagsByType),
    (r) => r.label,
  )
  const tagsByVendor = mergeKeyCounts<KeyCount>(
    parsed.map((c) => c.tagsByVendor),
    (r) => r.key,
  )
  const firing = parsed.reduce<FiringTiming>((acc, c) => addFiring(acc, c.firing), {
    pageview: 0,
    domReady: 0,
    windowLoad: 0,
    interaction: 0,
    custom: 0,
    unknown: 0,
  })

  const net = gtmNetwork(derived.requests)
  const cpu = gtmEntityCpu(artifacts)

  return {
    basis:
      'OBJECTIVE counts parsed from each container (fetched live, decoded via AST). ' +
      'Vendor attribution maps domains found in a tag\'s config (and unambiguous ' +
      'template types) to third-party-web entities — it answers "what is GTM used ' +
      'for / which vendor adds the most tags"; a tag may map to several vendors, ' +
      'so vendor counts can exceed the tag count, and a referenced domain is a ' +
      'config reference (not a confirmed load — see the third-party analyzer for ' +
      'actual bytes/CPU). Firing timing is from positive `if` triggers (blocking/' +
      'exception triggers not modeled). CPU/transfer cover GTM-served scripts only.',
    containers,
    gtagIds,
    totals: {
      containerCount: containers.length,
      parsedContainers: parsed.length,
      tags: sum(parsed, (c) => c.tags),
      customHtml: sum(parsed, (c) => c.customHtml),
      legacyUa: sum(parsed, (c) => c.legacyUa),
      pausedTags: sum(parsed, (c) => c.pausedTags),
      tagClass: {
        firing: sum(parsed, (c) => c.tagClass.firing),
        control: sum(parsed, (c) => c.tagClass.control),
        paused: sum(parsed, (c) => c.tagClass.paused),
      },
      variables: sum(parsed, (c) => c.variables),
      rules: sum(parsed, (c) => c.rules),
      firesOnPageview: sum(parsed, (c) => c.firesOnPageview),
      transferBytes: net.transferBytes,
      decodedBytes: net.decodedBytes,
      cpuMs: cpu.cpuMs,
      blockingMs: cpu.blockingMs,
    },
    tagsByType,
    tagsByVendor,
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
  const empty: GtmContainer = {
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
    tagClass: { firing: 0, control: 0, paused: 0 },
    tagsByType: [],
    tagsByVendor: [],
    firing: { pageview: 0, domReady: 0, windowLoad: 0, interaction: 0, custom: 0, unknown: 0 },
    firesOnPageview: 0,
  }

  try {
    const res = await ctx.fetch(`${GTM_BASE}${encodeURIComponent(id)}`)
    if (!res.ok) {
      ctx.logger.warn(`GTM ${id}: HTTP ${res.status}`)
      return { ...empty, error: `HTTP ${res.status}` }
    }
    const parsed = parseGtmContainer(await res.text())
    if (!parsed) {
      ctx.logger.warn(`GTM ${id}: could not parse container body`)
      return { ...empty, error: 'parse failed' }
    }
    const a = analyzeContainer(parsed.resource)
    return {
      id,
      url,
      fetched: true,
      parser: parsed.parser,
      transferBytes: net?.transferSize,
      decodedBytes: net?.resourceSize,
      ...a,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.logger.warn(`GTM ${id}: fetch error ${msg}`)
    return { ...empty, error: msg }
  }
}

// --- detection from the network --------------------------------------------

function detectContainerIds(requests: NetworkRequest[]): Array<{ id: string; url: string }> {
  const seen = new Map<string, string>()
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

// --- findings (objective overview, "what's GTM for / why so many") ----------

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
      `GTM コンテナ ${t.containerCount}個 (解析成功 ${t.parsedContainers})、タグ計 ${t.tags} / 変数 ${t.variables}。` +
      `転送 ${kb(t.transferBytes)}KB / GTM配信スクリプトCPU ${round(t.cpuMs)}ms (実負荷の詳細は third-party 分析へ)`,
    evidence: { containers: data.containers.map((c) => c.id), tags: t.tags },
  })

  // MECE split of every tag: actual firing tags vs control/listener vs paused.
  findings.push({
    severity: 'info',
    message:
      `タグ内訳(MECE): 発火 ${t.tagClass.firing} / 制御(リスナー) ${t.tagClass.control} / ` +
      `停止中 ${t.tagClass.paused} = 計 ${t.tags}`,
    evidence: { tagClass: t.tagClass },
  })

  // The headline answer: which vendors the tags are FOR.
  const vendors = data.tagsByVendor.filter((v) => v.key !== '(未帰属)').slice(0, 6)
  if (vendors.length > 0) {
    findings.push({
      severity: 'info',
      message: 'タグの用途(ベンダー別タグ数): ' + vendors.map((v) => `${v.key} ${v.count}`).join(' / '),
      evidence: { tagsByVendor: data.tagsByVendor.slice(0, 15) },
    })
  }

  findings.push({
    severity: 'info',
    message: 'タグ種別内訳: ' + data.tagsByType.slice(0, 6).map((x) => `${x.label} ${x.count}${x.deprecated ? '(非推奨)' : ''}`).join(' / '),
    evidence: { tagsByType: data.tagsByType },
  })

  findings.push({
    severity: 'info',
    message:
      `発火: pageview ${data.firing.pageview} / DOM ${data.firing.domReady} / load ${data.firing.windowLoad} / ` +
      `interaction ${data.firing.interaction} / custom ${data.firing.custom} / 不明 ${data.firing.unknown}`,
    evidence: { firing: data.firing },
  })

  // Objective dead-weight counts (light reflection, no cost claim).
  const deadweight: string[] = []
  if (t.customHtml > 0) deadweight.push(`カスタムHTML ${t.customHtml}`)
  if (t.legacyUa > 0) deadweight.push(`旧UA ${t.legacyUa}`)
  if (t.pausedTags > 0) deadweight.push(`停止中 ${t.pausedTags}`)
  if (deadweight.length > 0) {
    findings.push({
      severity: t.legacyUa > 0 || t.pausedTags > 0 || t.customHtml >= 30 ? 'warn' : 'info',
      message: `見直し候補の計数: ${deadweight.join(' / ')} (旧UA/停止中は死蔵、カスタムHTMLは任意JS)`,
      evidence: { customHtml: t.customHtml, legacyUa: t.legacyUa, pausedTags: t.pausedTags },
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
