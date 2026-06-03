/** Count of tags of one GTM function type, with a friendly label. */
export interface TagTypeCount {
  type: string // raw GTM function id, e.g. "__html"
  label: string // friendly name, e.g. "Custom HTML"
  count: number
  /** Deprecated/dead-weight tech (e.g. Universal Analytics). */
  deprecated?: boolean
}

/** How many tags fire at each lifecycle moment (a tag may fire on several). */
export interface FiringTiming {
  pageview: number // gtm.js — fires on every page (always-on cost)
  domReady: number // gtm.dom
  windowLoad: number // gtm.load
  interaction: number // click / scroll / form / timer / visibility
  custom: number // custom dataLayer events
  unknown: number // no resolvable trigger
}

/** A domain referenced inside Custom HTML tags (best-effort vendor hint). */
export interface CustomHtmlVendor {
  domain: string
  count: number
}

export interface GtmContainer {
  id: string // GTM-XXXX
  url: string
  fetched: boolean
  error?: string
  version?: string | number
  /** Transfer / decoded size from the network capture (if matched). */
  transferBytes?: number
  decodedBytes?: number
  // parsed counts
  tags: number
  variables: number // macros
  predicates: number
  rules: number
  customHtml: number
  legacyUa: number
  /** Tags paused in the GTM UI but still shipped in the container (dead weight). */
  pausedTags: number
  tagsByType: TagTypeCount[]
  firing: FiringTiming
  firesOnPageview: number
  customHtmlVendors: CustomHtmlVendor[]
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
    /** GTM + gtag transfer bytes from the network capture. */
    transferBytes: number
    decodedBytes: number
    /** "Google Tag Manager" entity CPU from third-party-summary (ms). */
    cpuMs: number
    /** "Google Tag Manager" entity blocking/TBT impact (ms). */
    blockingMs: number
  }
  /** Tag-type breakdown aggregated across containers, sorted by count desc. */
  tagsByType: TagTypeCount[]
  /** Firing timing aggregated across containers. */
  firing: FiringTiming
}
