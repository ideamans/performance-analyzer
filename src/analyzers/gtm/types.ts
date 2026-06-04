/** Count of tags of one GTM function type, with a friendly label. */
export interface TagTypeCount {
  type: string // raw GTM function id, e.g. "__html"
  label: string // friendly name, e.g. "Custom HTML"
  count: number
  /** Deprecated/dead-weight tech (e.g. Universal Analytics). */
  deprecated?: boolean
}

/** A generic keyed count (used for vendors and firing events). */
export interface KeyCount {
  key: string
  count: number
}

/**
 * How many tags fire at each lifecycle moment, derived objectively from each
 * tag's positive (`if`) firing triggers. (Blocking/exception triggers are not
 * modeled, so these are trigger-config counts, not guaranteed runtime fires.)
 */
export interface FiringTiming {
  pageview: number // gtm.js
  domReady: number // gtm.dom
  windowLoad: number // gtm.load
  interaction: number // click / scroll / form / timer / visibility
  custom: number // custom dataLayer events
  unknown: number // no resolvable trigger
}

export interface GtmContainer {
  id: string // GTM-XXXX
  url: string
  fetched: boolean
  parser?: 'ast' | 'json' // how the body was decoded
  error?: string
  version?: string | number
  transferBytes?: number
  decodedBytes?: number
  // objective counts
  tags: number
  variables: number // macros
  predicates: number
  rules: number
  customHtml: number
  legacyUa: number
  pausedTags: number
  tagsByType: TagTypeCount[]
  /** Tags attributed to a third-party vendor (by config domain / template type). */
  tagsByVendor: KeyCount[]
  /** Tags by firing event class. */
  firing: FiringTiming
  firesOnPageview: number
}

export interface GtagIds {
  ga4: string[] // G- / GT-
  ads: string[] // AW-
  floodlight: string[] // DC-
  universalAnalytics: string[] // UA- (deprecated)
  other: string[]
}

export interface GtmData {
  basis: string
  containers: GtmContainer[]
  gtagIds: GtagIds
  totals: {
    containerCount: number
    parsedContainers: number
    tags: number
    customHtml: number
    legacyUa: number
    pausedTags: number
    variables: number
    rules: number
    firesOnPageview: number
    transferBytes: number
    decodedBytes: number
    /** "Google Tag Manager" entity CPU/blocking from third-party-summary (ms). */
    cpuMs: number
    blockingMs: number
  }
  /** Tag-type breakdown aggregated across containers, sorted by count desc. */
  tagsByType: TagTypeCount[]
  /** Tags-per-vendor aggregated across containers — "what is GTM used for". */
  tagsByVendor: KeyCount[]
  /** Firing timing aggregated across containers. */
  firing: FiringTiming
}
