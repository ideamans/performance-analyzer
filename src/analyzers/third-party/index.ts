import type { AnalysisResult, Artifacts, Derived, Finding, LighthouseAudit } from '../../core/types.js'
import { hostOf, round } from '../../core/time.js'
import type { Analyzer, AnalyzerContext } from '../Analyzer.js'
import { classifyResource, measuredRootDomain } from './classify.js'
import type {
  BlockingSummary,
  FacadeOpportunity,
  PageShare,
  Redundancy,
  RenderBlockingTp,
  ThirdPartyData,
  TpAggregate,
  TpGroup,
  TpRequest,
} from './types.js'

const SCHEMA_VERSION = '2.0.0'

/** Analyzer 2: third-party tag volume, share, CPU, blocking and vendor breakdown. */
export const thirdPartyAnalyzer: Analyzer<ThirdPartyData> = {
  name: 'third-party',
  async analyze(ctx: AnalyzerContext): Promise<AnalysisResult<ThirdPartyData>> {
    const { artifacts, derived } = ctx
    const data = buildThirdPartyData(artifacts, derived)
    const findings = buildFindings(data)

    const s = data.share
    return {
      analyzer: 'third-party',
      schemaVersion: SCHEMA_VERSION,
      url: artifacts.meta.finalUrl ?? artifacts.meta.url,
      device: artifacts.meta.device,
      capturedAt: artifacts.meta.capturedAt,
      summary: {
        tagRequests: data.tags.count,
        tagVendors: data.distinctEntities,
        tagDomains: data.distinctDomains,
        // whole-page totals
        totalTransferKB: kb(s.transfer.total),
        totalDecodedKB: kb(s.resource.total),
        totalCpuMs: round(s.cpu.total),
        totalTbtMs: round(data.blocking.totalTbtMs),
        // third-party share (all resources)
        tpTransferShare: pct(s.transfer.thirdPartyShare),
        tpDecodedShare: pct(s.resource.thirdPartyShare),
        tpCpuShare: pct(s.cpu.thirdPartyShare),
        tpTbtShare: pct(data.blocking.thirdPartyTbtShare),
        // third-party JS only
        tpJsTransferKB: kb(s.transfer.thirdPartyJs),
        tpJsTransferShare: pct(s.transfer.thirdPartyJsShare),
        tpJsCpuShare: pct(s.cpu.thirdPartyJsShare),
        // blocking / vendors
        tpLongTasks: data.blocking.thirdPartyLongTasks,
        heaviestVendorByCpu: data.heaviestByCpu[0]?.key ?? 'n/a',
        heaviestVsAvg: data.heaviestByCpu[0]?.cpuVsAvg ?? undefined,
        cdnLibCount: data.cdnLibraries.count,
      },
      data,
      findings,
    }
  },
}

function buildThirdPartyData(artifacts: Artifacts, derived: Derived): ThirdPartyData {
  const measuredRoot = measuredRootDomain(artifacts.meta.finalUrl ?? artifacts.meta.url)
  const cpuByUrl = buildCpuMap(artifacts)

  const tagRequests: TpRequest[] = []
  const cdnLibraryRequests: TpRequest[] = []
  const firstParty: TpAggregate = emptyAgg()

  for (const r of derived.requests) {
    const host = r.host || hostOf(r.url)
    const c = classifyResource(r.url, host, measuredRoot)
    // Consume the per-URL CPU so duplicate-URL requests don't double-count it
    // (the third-party-summary value is already the total for that URL).
    const cpu = cpuByUrl.get(r.url)
    if (cpu) cpuByUrl.delete(r.url)
    const entry: TpRequest = {
      url: r.url,
      host,
      rootDomain: c.rootDomain,
      entity: c.entity,
      category: c.category,
      resourceType: r.resourceType,
      transferBytes: r.transferSize,
      resourceBytes: r.resourceSize,
      cpuMs: cpu?.cpuMs ?? 0,
      blockingMs: cpu?.blockingMs ?? 0,
      beforeLcp: r.beforeLCP,
      avgExecutionMs: c.avgExecutionMs,
    }
    if (c.kind === 'first') addInto(firstParty, entry)
    else if (c.kind === 'cdnLib') cdnLibraryRequests.push(entry)
    else tagRequests.push(entry)
  }

  const tagsTotal = aggregate(tagRequests)
  const beforeLcp = aggregate(tagRequests.filter((r) => r.beforeLcp))
  const afterLcp = aggregate(tagRequests.filter((r) => !r.beforeLcp))

  const byDomain = groupBy(tagRequests, (r) => r.rootDomain, true).sort(byCpu)
  const byEntity = groupBy(tagRequests, (r) => r.entity, true).sort(byCpu)
  const byCategory = groupBy(tagRequests, (r) => r.category, false).sort(byCpu)

  return {
    basis:
      'Per-request bytes/count from the network; per-URL CPU & blocking from the ' +
      'third-party-summary audit. Whole-page totals: transfer/decoded summed over ' +
      'all requests, CPU = total main-thread self-time, TBT = total-blocking-time ' +
      'audit. "JS only" = script resources. Shares are third-party ÷ whole page.',
    rules:
      'Tags = analytics/ads/pixels/A-B/chat/tag-managers/social + external web fonts ' +
      '(Google Fonts). Excluded = public CDN libraries (jsDelivr/cdnjs/unpkg/jQuery/' +
      'Google CDN…), shown separately. First party = page registrable domain.',
    tags: { ...tagsTotal, beforeLcp, afterLcp },
    cdnLibraries: aggregate(cdnLibraryRequests),
    firstParty,
    distinctEntities: byEntity.length,
    distinctDomains: byDomain.length,
    share: buildShare(derived, tagRequests),
    blocking: buildBlocking(artifacts, derived, tagsTotal, measuredRoot),
    redundancy: buildRedundancy(tagRequests),
    facades: buildFacades(artifacts),
    renderBlocking: buildRenderBlocking(artifacts, measuredRoot),
    byDomain,
    byEntity,
    byCategory,
    heaviestByCpu: [...byEntity].sort(byCpu).slice(0, 10),
    heaviestByTransfer: [...byEntity].sort((a, b) => b.transferBytes - a.transferBytes).slice(0, 10),
    tagRequests: tagRequests.sort((a, b) => b.cpuMs - a.cpuMs || b.transferBytes - a.transferBytes),
    cdnLibraryRequests,
  }
}

// --- whole-page share (transfer / decoded / CPU), with a JS-only cut --------

function buildShare(derived: Derived, tags: TpRequest[]): ThirdPartyData['share'] {
  const totalTransfer = derived.requests.reduce((s, r) => s + r.transferSize, 0)
  const totalResource = derived.requests.reduce((s, r) => s + r.resourceSize, 0)
  const totalCpu = derived.mainThread.reduce((s, t) => s + t.duration, 0)

  const tagsJs = tags.filter((r) => r.resourceType === 'script')
  const sum = (arr: TpRequest[], key: 'transferBytes' | 'resourceBytes' | 'cpuMs'): number =>
    arr.reduce((s, r) => s + r[key], 0)

  const share = (total: number, tp: number, tpJs: number): PageShare => ({
    total: round(total)!,
    thirdParty: round(tp)!,
    thirdPartyJs: round(tpJs)!,
    thirdPartyShare: total > 0 ? round(tp / total, 3)! : 0,
    thirdPartyJsShare: total > 0 ? round(tpJs / total, 3)! : 0,
  })

  return {
    transfer: share(totalTransfer, sum(tags, 'transferBytes'), sum(tagsJs, 'transferBytes')),
    resource: share(totalResource, sum(tags, 'resourceBytes'), sum(tagsJs, 'resourceBytes')),
    cpu: share(totalCpu, sum(tags, 'cpuMs'), sum(tagsJs, 'cpuMs')),
  }
}

// --- blocking (TBT contribution + long tasks) ------------------------------

function buildBlocking(
  artifacts: Artifacts,
  derived: Derived,
  tags: TpAggregate,
  measuredRoot: string,
): BlockingSummary {
  const tbtAudit = artifacts.lhr.audits?.['total-blocking-time'] as LighthouseAudit | undefined
  const totalTbt = typeof tbtAudit?.numericValue === 'number' ? tbtAudit.numericValue : 0

  // Long tasks attributed to a third-party tag (by the task's attributable URL).
  let tpLongTasks = 0
  for (const t of derived.longTasks) {
    if (!t.attributableUrl) continue
    const c = classifyResource(t.attributableUrl, hostOf(t.attributableUrl), measuredRoot)
    if (c.kind === 'tag') tpLongTasks += 1
  }

  return {
    totalTbtMs: round(totalTbt)!,
    thirdPartyTbtMs: round(tags.blockingMs)!,
    thirdPartyTbtShare: totalTbt > 0 ? round(tags.blockingMs / totalTbt, 3)! : 0,
    thirdPartyLongTasks: tpLongTasks,
    totalLongTasks: derived.longTasks.length,
  }
}

// --- redundancy / duplication ----------------------------------------------

function buildRedundancy(tags: TpRequest[]): Redundancy {
  const distinct = (pred: (r: TpRequest) => boolean): string[] =>
    [...new Set(tags.filter(pred).map((r) => r.entity))]

  const analyticsVendors = distinct((r) => r.category === 'analytics')
  const tagManagerVendors = distinct((r) => r.category === 'tag-manager')

  const gtmContainers = new Set<string>()
  const ga4Ids = new Set<string>()
  for (const r of tags) {
    const gtm = /[?&]id=(GTM-[A-Z0-9]+)/i.exec(r.url)
    if (gtm) gtmContainers.add(gtm[1]!.toUpperCase())
    const ga = /[?&]id=(G-[A-Z0-9]+)/i.exec(r.url)
    if (ga) ga4Ids.add(ga[1]!.toUpperCase())
  }

  const notes: string[] = []
  if (analyticsVendors.length > 1) notes.push(`アナリティクスが${analyticsVendors.length}種: ${analyticsVendors.join(', ')}`)
  if (tagManagerVendors.length > 1) notes.push(`タグマネージャが${tagManagerVendors.length}種: ${tagManagerVendors.join(', ')}`)
  if (gtmContainers.size > 1) notes.push(`GTMコンテナ${gtmContainers.size}個: ${[...gtmContainers].join(', ')}`)
  if (ga4Ids.size > 1) notes.push(`GA4計測ID${ga4Ids.size}個: ${[...ga4Ids].join(', ')}`)

  return {
    analyticsVendors,
    tagManagerVendors,
    gtmContainers: [...gtmContainers],
    ga4Ids: [...ga4Ids],
    notes,
  }
}

// --- facades (lazy-load opportunities) -------------------------------------

function buildFacades(artifacts: Artifacts): FacadeOpportunity[] {
  const audit = artifacts.lhr.audits?.['third-party-facades'] as LighthouseAudit | undefined
  const items = (audit?.details?.items ?? []) as Array<Record<string, unknown>>
  return items.map((i) => ({
    entity: typeof i.entity === 'string' ? i.entity : entityText(i.entity),
    product: typeof i.product === 'string' ? i.product : undefined,
  }))
}

function entityText(v: unknown): string {
  if (v && typeof v === 'object' && 'text' in v && typeof (v as { text?: unknown }).text === 'string') {
    return (v as { text: string }).text
  }
  return 'unknown'
}

// --- render-blocking third-party resources ---------------------------------

function buildRenderBlocking(artifacts: Artifacts, measuredRoot: string): RenderBlockingTp[] {
  const audit = artifacts.lhr.audits?.['render-blocking-resources'] as LighthouseAudit | undefined
  const items = (audit?.details?.items ?? []) as Array<Record<string, unknown>>
  const out: RenderBlockingTp[] = []
  for (const i of items) {
    const url = typeof i.url === 'string' ? i.url : undefined
    if (!url) continue
    const c = classifyResource(url, hostOf(url), measuredRoot)
    if (c.kind !== 'tag') continue
    out.push({
      url,
      entity: c.entity,
      transferBytes: num(i.totalBytes) ?? 0,
      wastedMs: num(i.wastedMs),
    })
  }
  return out
}

// --- aggregation helpers ----------------------------------------------------

function buildCpuMap(artifacts: Artifacts): Map<string, { cpuMs: number; blockingMs: number }> {
  const map = new Map<string, { cpuMs: number; blockingMs: number }>()
  const audit = artifacts.lhr.audits?.['third-party-summary'] as LighthouseAudit | undefined
  const items = (audit?.details?.items ?? []) as Array<Record<string, unknown>>
  for (const item of items) {
    const sub = (item.subItems as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? []
    for (const s of sub) {
      const url = typeof s.url === 'string' ? s.url : undefined
      if (!url) continue
      map.set(url, { cpuMs: num(s.mainThreadTime) ?? 0, blockingMs: num(s.blockingTime) ?? 0 })
    }
  }
  return map
}

function emptyAgg(): TpAggregate {
  return { count: 0, transferBytes: 0, resourceBytes: 0, cpuMs: 0, blockingMs: 0 }
}

function addInto(acc: TpAggregate, r: TpRequest): void {
  acc.count += 1
  acc.transferBytes += r.transferBytes
  acc.resourceBytes += r.resourceBytes
  acc.cpuMs += r.cpuMs
  acc.blockingMs += r.blockingMs
}

function aggregate(reqs: TpRequest[]): TpAggregate {
  const a = emptyAgg()
  for (const r of reqs) addInto(a, r)
  a.cpuMs = round(a.cpuMs, 1)!
  a.blockingMs = round(a.blockingMs, 1)!
  return a
}

function groupBy(reqs: TpRequest[], keyFn: (r: TpRequest) => string, withAvg: boolean): TpGroup[] {
  const map = new Map<string, TpGroup>()
  for (const r of reqs) {
    const key = keyFn(r)
    let g = map.get(key)
    if (!g) {
      g = {
        key,
        entity: r.entity,
        category: r.category,
        count: 0,
        transferBytes: 0,
        resourceBytes: 0,
        cpuMs: 0,
        blockingMs: 0,
        beforeLcpCount: 0,
        beforeLcpTransferBytes: 0,
        jsCpuMs: 0,
        jsTransferBytes: 0,
        avgExecutionMs: withAvg ? r.avgExecutionMs : undefined,
      }
      map.set(key, g)
    }
    g.count += 1
    g.transferBytes += r.transferBytes
    g.resourceBytes += r.resourceBytes
    g.cpuMs += r.cpuMs
    g.blockingMs += r.blockingMs
    if (r.resourceType === 'script') {
      g.jsCpuMs += r.cpuMs
      g.jsTransferBytes += r.transferBytes
    }
    if (r.beforeLcp) {
      g.beforeLcpCount += 1
      g.beforeLcpTransferBytes += r.transferBytes
    }
  }
  for (const g of map.values()) {
    g.cpuMs = round(g.cpuMs, 1)!
    g.blockingMs = round(g.blockingMs, 1)!
    g.jsCpuMs = round(g.jsCpuMs, 1)!
    if (g.avgExecutionMs && g.avgExecutionMs > 0) g.cpuVsAvg = round(g.cpuMs / g.avgExecutionMs, 2)
  }
  return [...map.values()]
}

function byCpu(a: TpGroup, b: TpGroup): number {
  return b.cpuMs - a.cpuMs || b.transferBytes - a.transferBytes
}

// --- findings ---------------------------------------------------------------

function buildFindings(data: ThirdPartyData): Finding[] {
  const findings: Finding[] = []
  const t = data.tags
  const s = data.share

  findings.push({
    severity: t.count > 30 ? 'warn' : 'info',
    message:
      `サードパーティタグ ${t.count}リクエスト / ${data.distinctEntities}ベンダー / ${data.distinctDomains}ドメイン。` +
      `転送 ${kb(t.transferBytes)}KB(全体の${pct(s.transfer.thirdPartyShare)}%) / ` +
      `解凍後 ${kb(t.resourceBytes)}KB(${pct(s.resource.thirdPartyShare)}%) / ` +
      `CPU ${round(t.cpuMs)}ms(${pct(s.cpu.thirdPartyShare)}%)`,
    evidence: { requests: t.count, vendors: data.distinctEntities },
  })

  findings.push({
    severity: s.cpu.thirdPartyJsShare > 0.4 ? 'warn' : 'info',
    message:
      `うち第三者JS: 転送 ${kb(s.transfer.thirdPartyJs)}KB(全体の${pct(s.transfer.thirdPartyJsShare)}%) / ` +
      `CPU ${round(s.cpu.thirdPartyJs)}ms(${pct(s.cpu.thirdPartyJsShare)}%)`,
    evidence: { jsCpuShare: s.cpu.thirdPartyJsShare, jsTransferShare: s.transfer.thirdPartyJsShare },
  })

  const b = data.blocking
  if (b.totalTbtMs > 0) {
    findings.push({
      severity: b.thirdPartyTbtShare > 0.5 ? 'warn' : 'info',
      message: `第三者のTBT寄与 ${round(b.thirdPartyTbtMs)}ms / 全体${round(b.totalTbtMs)}ms (${pct(b.thirdPartyTbtShare)}%)、第三者起因のLong Task ${b.thirdPartyLongTasks}/${b.totalLongTasks}本`,
      evidence: { thirdPartyTbtMs: round(b.thirdPartyTbtMs), share: b.thirdPartyTbtShare, longTasks: b.thirdPartyLongTasks },
    })
  }

  // Heaviest vendors with industry-average comparison.
  const top = data.heaviestByCpu.filter((g) => g.cpuMs > 0).slice(0, 5)
  if (top.length > 0) {
    findings.push({
      severity: 'info',
      message:
        'CPU重いベンダー: ' +
        top
          .map((g) => `${g.key} ${round(g.cpuMs)}ms${g.cpuVsAvg ? `(業界平均の${g.cpuVsAvg}倍)` : ''}`)
          .join(' / '),
      evidence: { top: top.map((g) => ({ entity: g.key, cpuMs: round(g.cpuMs), cpuVsAvg: g.cpuVsAvg })) },
    })
  }

  // Vendors configured much heavier than typical.
  const overweight = data.heaviestByCpu.filter((g) => g.cpuVsAvg !== undefined && g.cpuVsAvg >= 2 && g.cpuMs >= 200)
  if (overweight.length > 0) {
    findings.push({
      severity: 'warn',
      message:
        '業界平均より重い使い方: ' +
        overweight.map((g) => `${g.key} ${g.cpuVsAvg}倍(${round(g.cpuMs)}ms)`).join(' / '),
      evidence: { overweight: overweight.map((g) => ({ entity: g.key, cpuVsAvg: g.cpuVsAvg })) },
    })
  }

  for (const note of data.redundancy.notes) {
    findings.push({ severity: 'warn', message: `冗長: ${note}` })
  }

  if (data.renderBlocking.length > 0) {
    findings.push({
      severity: 'warn',
      message:
        'レンダーブロッキングの第三者: ' +
        data.renderBlocking.map((r) => `${r.entity}(${kb(r.transferBytes)}KB${r.wastedMs ? `, ${Math.round(r.wastedMs)}ms` : ''})`).join(' / '),
      evidence: { items: data.renderBlocking },
    })
  }

  if (data.facades.length > 0) {
    findings.push({
      severity: 'info',
      message: `遅延読込(ファサード)候補: ${data.facades.map((f) => f.product ?? f.entity).join(', ')}`,
    })
  }

  if (t.beforeLcp.count > 0) {
    findings.push({
      severity: t.beforeLcp.cpuMs > 300 || t.beforeLcp.count > 10 ? 'warn' : 'info',
      message: `LCP前に読まれたタグ ${t.beforeLcp.count}本 / ${kb(t.beforeLcp.transferBytes)}KB / CPU ${round(t.beforeLcp.cpuMs)}ms`,
    })
  }

  if (data.cdnLibraries.count > 0) {
    findings.push({
      severity: 'info',
      message: `(参考) 除外したCDNライブラリ ${data.cdnLibraries.count}本 / ${kb(data.cdnLibraries.transferBytes)}KB — 置換可能なのでタグ対象外`,
    })
  }

  return findings
}

function kb(bytes: number): number {
  return Math.round(bytes / 1024)
}

function pct(ratio: number): number {
  return Math.round(ratio * 100)
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export type { ThirdPartyData } from './types.js'
