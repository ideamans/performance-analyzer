import thirdPartyWeb from 'third-party-web'

import type { GtmResource } from './parse.js'
import type { FiringTiming, KeyCount, TagClass, TagTypeCount } from './types.js'

const { getEntity } = thirdPartyWeb

/** Friendly labels for GTM tag function ids, and deprecation flags. */
const TAG_LABELS: Record<string, { label: string; deprecated?: boolean }> = {
  __html: { label: 'Custom HTML' },
  __gaawe: { label: 'GA4 Event' },
  __googtag: { label: 'Google Tag (gtag)' },
  __gtag: { label: 'Google Tag (gtag)' },
  __ua: { label: 'Universal Analytics', deprecated: true },
  __gclidw: { label: 'Conversion Linker' },
  __awct: { label: 'Google Ads Conversion' },
  __sp: { label: 'Google Ads Remarketing' },
  __baut: { label: 'Microsoft UET (Bing)' },
  __twitter_website_tag: { label: 'Twitter/X' },
  __pntr: { label: 'Pinterest' },
  __bzi: { label: 'LinkedIn Insight' },
  __cl: { label: 'Click Listener' },
  __lcl: { label: 'Link Click Listener' },
  __fsl: { label: 'Form Submit Listener' },
  __evl: { label: 'Element Visibility Listener' },
  __jel: { label: 'JS Error Listener' },
  __tl: { label: 'Timer Listener' },
  __sdl: { label: 'Scroll Depth Listener' },
  __ytl: { label: 'YouTube Listener' },
  __hl: { label: 'History Listener' },
  __zone: { label: 'Zone' },
  __paused: { label: 'Paused (停止中・死蔵)' },
}

/** Tag function id → vendor, for templates whose vendor is unambiguous. */
const FUNCTION_VENDOR: Record<string, string> = {
  __gaawe: 'Google Analytics',
  __ua: 'Google Analytics',
  __googtag: 'Google',
  __gclidw: 'Google Ads',
  __awct: 'Google Ads',
  __sp: 'Google Ads',
  __baut: 'Bing Ads',
  __twitter_website_tag: 'Twitter',
  __pntr: 'Pinterest',
  __bzi: 'LinkedIn',
}

/**
 * Control / infrastructure tags: auto-event listeners and zone. They set up
 * triggers (listen for clicks/scrolls/etc.) but send no data themselves.
 */
const CONTROL_FUNCTIONS = new Set([
  '__cl',
  '__lcl',
  '__fsl',
  '__evl',
  '__jel',
  '__tl',
  '__sdl',
  '__ytl',
  '__hl',
  '__zone',
])

/** MECE class of a tag: paused > control(listener) > firing. */
function tagClassOf(fn: string | undefined): keyof TagClass {
  if (fn === '__paused') return 'paused'
  if (fn && CONTROL_FUNCTIONS.has(fn)) return 'control'
  return 'firing'
}

const INTERACTION_EVENTS = new Set([
  'gtm.click',
  'gtm.linkClick',
  'gtm.formSubmit',
  'gtm.scrollDepth',
  'gtm.timer',
  'gtm.historyChange',
  'gtm.elementVisibility',
  'gtm.video',
])

export interface ContainerAnalysis {
  version?: string | number
  tags: number
  variables: number
  predicates: number
  rules: number
  customHtml: number
  legacyUa: number
  pausedTags: number
  tagClass: TagClass
  tagsByType: TagTypeCount[]
  tagsByVendor: KeyCount[]
  firing: FiringTiming
  firesOnPageview: number
}

function labelFor(fn: string | undefined): { label: string; deprecated?: boolean } {
  if (!fn) return { label: 'unknown' }
  if (TAG_LABELS[fn]) return TAG_LABELS[fn]!
  if (fn.startsWith('__cvt_')) return { label: 'Custom Template' }
  return { label: `その他 (${fn})` }
}

/** Objectively analyze a parsed container resource (no network data). */
export function analyzeContainer(resource: GtmResource): ContainerAnalysis {
  const tags = resource.tags ?? []
  const macros = resource.macros ?? []
  const predicates = resource.predicates ?? []
  const rules = resource.rules ?? []

  const byLabel = new Map<string, TagTypeCount>()
  const byVendor = new Map<string, number>()
  let customHtml = 0
  let legacyUa = 0
  let pausedTags = 0
  const tagClass: TagClass = { firing: 0, control: 0, paused: 0 }

  for (const t of tags) {
    const { label, deprecated } = labelFor(t.function)
    if (t.function === '__html') customHtml++
    if (t.function === '__paused') pausedTags++
    if (deprecated) legacyUa++
    tagClass[tagClassOf(t.function)]++

    let row = byLabel.get(label)
    if (!row) {
      row = { type: t.function ?? 'unknown', label, count: 0, deprecated }
      byLabel.set(label, row)
    }
    row.count++

    const vendors = tagVendors(t)
    if (vendors.length === 0) byVendor.set('(未帰属)', (byVendor.get('(未帰属)') ?? 0) + 1)
    for (const v of vendors) byVendor.set(v, (byVendor.get(v) ?? 0) + 1)
  }

  const { firing, firesOnPageview } = classifyFiring(resource)

  return {
    version: resource.version,
    tags: tags.length,
    variables: macros.length,
    predicates: predicates.length,
    rules: rules.length,
    customHtml,
    legacyUa,
    pausedTags,
    tagClass,
    tagsByType: [...byLabel.values()].sort((a, b) => b.count - a.count),
    tagsByVendor: toKeyCounts(byVendor),
    firing,
    firesOnPageview,
  }
}

/** Vendor(s) a tag serves: recognized config domains, else its template vendor. */
function tagVendors(tag: Record<string, unknown>): string[] {
  const ents = new Set<string>()
  for (const host of tagDomains(tag)) {
    const e = getEntity(`https://${host}/`)
    if (e?.name) ents.add(e.name)
  }
  if (ents.size === 0) {
    const fn = typeof tag.function === 'string' ? tag.function : undefined
    const fv = fn ? FUNCTION_VENDOR[fn] : undefined
    if (fv) ents.add(fv)
  }
  return [...ents]
}

/** Hostnames referenced anywhere in a tag's string config values. */
function tagDomains(tag: Record<string, unknown>): Set<string> {
  const hosts = new Set<string>()
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) hosts.add(m[1]!.toLowerCase())
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x)
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v)) visit(x)
    }
  }
  visit(tag)
  return hosts
}

/** Resolve each tag's firing events via __e macros → `if` predicates → rules. */
function classifyFiring(r: GtmResource): { firing: FiringTiming; firesOnPageview: number } {
  const tags = r.tags ?? []
  const macros = r.macros ?? []
  const predicates = r.predicates ?? []
  const rules = r.rules ?? []

  const eventMacro = new Set<number>()
  macros.forEach((m, i) => {
    if (m.function === '__e') eventMacro.add(i)
  })

  const predEvent = new Map<number, string>()
  predicates.forEach((p, i) => {
    const a0 = p.arg0
    if (Array.isArray(a0) && a0[0] === 'macro' && typeof a0[1] === 'number' && eventMacro.has(a0[1]) && typeof p.arg1 === 'string') {
      predEvent.set(i, p.arg1)
    }
  })

  const tagEvents = new Map<number, Set<string>>()
  for (const rule of rules) {
    if (!Array.isArray(rule)) continue
    // Positive `if` conditions only — `unless`/`block` don't mark when a tag fires.
    const preds: number[] = []
    const addTags: number[] = []
    for (const clause of rule) {
      if (!Array.isArray(clause)) continue
      const op = clause[0]
      const idxs = clause.slice(1).filter((x): x is number => typeof x === 'number')
      if (op === 'if') preds.push(...idxs)
      else if (op === 'add') addTags.push(...idxs)
    }
    const events = preds.map((p) => predEvent.get(p)).filter((e): e is string => Boolean(e))
    for (const t of addTags) {
      let s = tagEvents.get(t)
      if (!s) {
        s = new Set()
        tagEvents.set(t, s)
      }
      for (const e of events) s.add(e)
    }
  }

  const firing: FiringTiming = { pageview: 0, domReady: 0, windowLoad: 0, interaction: 0, custom: 0, unknown: 0 }
  let firesOnPageview = 0
  tags.forEach((_, i) => {
    const ev = tagEvents.get(i)
    if (!ev || ev.size === 0) {
      firing.unknown++
      return
    }
    const buckets = new Set<keyof FiringTiming>()
    for (const e of ev) {
      if (e === 'gtm.js') buckets.add('pageview')
      else if (e === 'gtm.dom') buckets.add('domReady')
      else if (e === 'gtm.load') buckets.add('windowLoad')
      else if (INTERACTION_EVENTS.has(e)) buckets.add('interaction')
      else buckets.add('custom')
    }
    for (const b of buckets) firing[b]++
    if (ev.has('gtm.js')) firesOnPageview++
  })

  return { firing, firesOnPageview }
}

function toKeyCounts(map: Map<string, number>): KeyCount[] {
  return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count)
}

/** Sum two firing-timing breakdowns. */
export function addFiring(a: FiringTiming, b: FiringTiming): FiringTiming {
  return {
    pageview: a.pageview + b.pageview,
    domReady: a.domReady + b.domReady,
    windowLoad: a.windowLoad + b.windowLoad,
    interaction: a.interaction + b.interaction,
    custom: a.custom + b.custom,
    unknown: a.unknown + b.unknown,
  }
}

/** Merge keyed counts (tag types or vendors) across containers. */
export function mergeKeyCounts<T extends { count: number }>(rows: T[][], keyOf: (r: T) => string): T[] {
  const map = new Map<string, T>()
  for (const list of rows) {
    for (const r of list) {
      const k = keyOf(r)
      const existing = map.get(k)
      if (existing) existing.count += r.count
      else map.set(k, { ...r })
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}
