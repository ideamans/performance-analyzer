import type { ResourceType } from '../../core/types.js'

/** A roll-up aggregate: counts, bytes, CPU and blocking time. */
export interface TpAggregate {
  count: number
  transferBytes: number
  resourceBytes: number
  cpuMs: number
  blockingMs: number
}

/** An aggregate keyed by domain / entity / category, with an LCP-before split. */
export interface TpGroup extends TpAggregate {
  key: string
  /** For domain groups: the entity that owns the domain. */
  entity?: string
  category?: string
  beforeLcpCount: number
  beforeLcpTransferBytes: number
  /** Script-only CPU/transfer within this group (JS is the main concern). */
  jsCpuMs: number
  jsTransferBytes: number
  /** Industry-average execution time for this entity (third-party-web), ms. */
  avgExecutionMs?: number
  /** This group's CPU ÷ the entity's industry average (>1 = heavier than typical). */
  cpuVsAvg?: number
}

/** Third-party share of a whole-page metric, split out by JS only. */
export interface PageShare {
  total: number
  thirdParty: number
  thirdPartyJs: number
  thirdPartyShare: number // 0..1
  thirdPartyJsShare: number // 0..1
}

export interface BlockingSummary {
  totalTbtMs: number
  thirdPartyTbtMs: number
  thirdPartyTbtShare: number // 0..1
  thirdPartyLongTasks: number
  totalLongTasks: number
}

export interface Redundancy {
  analyticsVendors: string[]
  tagManagerVendors: string[]
  /** Distinct GTM container ids (gtm.js?id=GTM-…). */
  gtmContainers: string[]
  /** Distinct GA4 measurement ids (gtag/js?id=G-…). */
  ga4Ids: string[]
  notes: string[]
}

export interface FacadeOpportunity {
  entity: string
  product?: string
}

export interface RenderBlockingTp {
  url: string
  entity: string
  transferBytes: number
  wastedMs?: number
}

/** One classified third-party request (the rollup unit). */
export interface TpRequest {
  url: string
  host: string
  rootDomain: string
  entity: string
  category: string
  resourceType: ResourceType
  transferBytes: number
  resourceBytes: number
  cpuMs: number
  blockingMs: number
  beforeLcp: boolean
  avgExecutionMs?: number
}

export interface ThirdPartyData {
  basis: string
  rules: string
  /** Tags only (CDN libraries excluded), with an LCP before/after split. */
  tags: TpAggregate & { beforeLcp: TpAggregate; afterLcp: TpAggregate }
  /** Excluded public CDN libraries (shown for transparency). */
  cdnLibraries: TpAggregate
  /** First-party totals, for context (CPU not measured here). */
  firstParty: TpAggregate
  distinctEntities: number
  distinctDomains: number
  /** Third-party share of whole-page transfer / decoded size / CPU (with JS-only cut). */
  share: { transfer: PageShare; resource: PageShare; cpu: PageShare }
  /** Blocking (TBT) contribution and long tasks. */
  blocking: BlockingSummary
  /** Redundant / duplicated tooling. */
  redundancy: Redundancy
  /** Heavy embeds that could be lazy-loaded (Lighthouse third-party-facades). */
  facades: FacadeOpportunity[]
  /** Render-blocking third-party resources (Lighthouse render-blocking-resources). */
  renderBlocking: RenderBlockingTp[]
  /** Breakdowns over tags, each sorted by CPU desc. */
  byDomain: TpGroup[]
  byEntity: TpGroup[]
  byCategory: TpGroup[]
  /** Heaviest vendors (entities). */
  heaviestByCpu: TpGroup[]
  heaviestByTransfer: TpGroup[]
  /** All tag requests (for diffing common tags across pages). */
  tagRequests: TpRequest[]
  /** Excluded CDN library requests, for transparency. */
  cdnLibraryRequests: TpRequest[]
}
