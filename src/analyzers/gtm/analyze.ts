import type { GtmResource } from './parse.js'
import type { CustomHtmlVendor, FiringTiming, GtmContainer, TagTypeCount } from './types.js'

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
  __gcs: { label: 'Conversion (legacy)', deprecated: true },
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

function labelFor(fn: string | undefined): { label: string; deprecated?: boolean } {
  if (!fn) return { label: 'unknown' }
  if (TAG_LABELS[fn]) return TAG_LABELS[fn]!
  if (fn.startsWith('__cvt_')) return { label: 'Custom Template' }
  return { label: `その他 (${fn})` }
}

/** Analyze a parsed container resource into the per-container shape (no net data). */
export function analyzeContainer(id: string, url: string, resource: GtmResource): GtmContainer {
  const tags = resource.tags ?? []
  const macros = resource.macros ?? []
  const predicates = resource.predicates ?? []
  const rules = resource.rules ?? []

  // tag-type breakdown, grouped by friendly label
  const byLabel = new Map<string, TagTypeCount>()
  let customHtml = 0
  let legacyUa = 0
  let pausedTags = 0
  for (const t of tags) {
    const { label, deprecated } = labelFor(t.function)
    if (t.function === '__html') customHtml++
    if (t.function === '__paused') pausedTags++
    if (deprecated) legacyUa += 1
    let row = byLabel.get(label)
    if (!row) {
      row = { type: t.function ?? 'unknown', label, count: 0, deprecated }
      byLabel.set(label, row)
    }
    row.count++
  }
  const tagsByType = [...byLabel.values()].sort((a, b) => b.count - a.count)

  const { firing, firesOnPageview } = classifyFiring(resource)

  return {
    id,
    url,
    fetched: true,
    version: resource.version,
    tags: tags.length,
    variables: macros.length,
    predicates: predicates.length,
    rules: rules.length,
    customHtml,
    legacyUa,
    pausedTags,
    tagsByType,
    firing,
    firesOnPageview,
    customHtmlVendors: customHtmlVendors(resource),
  }
}

/** Resolve each tag's firing events via predicates(__e) → rules → tags. */
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
    // Firing events come from positive `if` conditions only. `unless` is an
    // exception (negative) condition and `block` removes tags — neither marks
    // when a tag fires, so they must not contribute firing events.
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

/** Domains referenced inside Custom HTML tags — a best-effort vendor hint. */
function customHtmlVendors(r: GtmResource): CustomHtmlVendor[] {
  const counts = new Map<string, number>()
  for (const t of r.tags ?? []) {
    if (t.function !== '__html') continue
    const html = typeof t.vtp_html === 'string' ? t.vtp_html : ''
    const seen = new Set<string>()
    for (const m of html.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      const host = m[1]!.toLowerCase()
      if (seen.has(host)) continue
      seen.add(host)
      counts.set(host, (counts.get(host) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
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

/** Merge tag-type breakdowns across containers, by label. */
export function mergeTagTypes(rows: TagTypeCount[][]): TagTypeCount[] {
  const map = new Map<string, TagTypeCount>()
  for (const list of rows) {
    for (const r of list) {
      const existing = map.get(r.label)
      if (existing) existing.count += r.count
      else map.set(r.label, { ...r })
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}
