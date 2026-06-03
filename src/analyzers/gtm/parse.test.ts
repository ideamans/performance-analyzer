import { describe, expect, it } from 'vitest'

import { analyzeContainer } from './analyze.js'
import { parseGtmResource } from './parse.js'

// A minimal but realistic gtm.js body. Two __e (Event) variables drive firing:
//   macro 0 = Event (__e)
//   predicate 0: Event _eq "gtm.js"  (pageview)
//   predicate 1: Event _eq "gtm.dom" (DOM ready)
//   predicate 2: Event _eq "purchase" (custom)
// rules wire tags to predicates. Tag bodies include a brace+quote in vtp_html to
// exercise the string-aware brace scanner.
const SAMPLE = `
window.google_tag_manager = {};
var data = {
  "resource": {
    "version": "42",
    "macros": [ {"function":"__e"}, {"function":"__v","vtp_name":"x"} ],
    "tags": [
      {"function":"__html","vtp_html":"<script>var o={a:1};fetch('https://vendor-a.example/p.gif?q={x}')</script>"},
      {"function":"__gaawe","vtp_eventName":"page_view"},
      {"function":"__ua","vtp_trackType":"TRACK_PAGEVIEW"},
      {"function":"__paused"}
    ],
    "predicates": [
      {"function":"_eq","arg0":["macro",0],"arg1":"gtm.js"},
      {"function":"_eq","arg0":["macro",0],"arg1":"gtm.dom"},
      {"function":"_eq","arg0":["macro",0],"arg1":"purchase"}
    ],
    "rules": [
      [["if",0],["add",0,2]],
      [["if",1],["add",1]],
      [["if",2],["add",1]]
    ]
  }
};
var b = 1;
`

describe('parseGtmResource', () => {
  it('extracts resource even with braces/quotes inside Custom HTML', () => {
    const r = parseGtmResource(SAMPLE)
    expect(r).not.toBeNull()
    expect(r!.version).toBe('42')
    expect(r!.tags).toHaveLength(4)
    expect(r!.macros).toHaveLength(2)
  })

  it('returns null when there is no var data block', () => {
    expect(parseGtmResource('console.log("no container here")')).toBeNull()
  })

  it('returns null on malformed JSON rather than throwing', () => {
    expect(parseGtmResource('var data = {not json,,,}')).toBeNull()
  })
})

describe('analyzeContainer', () => {
  const container = analyzeContainer('GTM-TEST', 'https://x/gtm.js?id=GTM-TEST', parseGtmResource(SAMPLE)!)

  it('counts custom HTML, legacy UA and paused tags', () => {
    expect(container.customHtml).toBe(1)
    expect(container.legacyUa).toBe(1) // __ua
    expect(container.pausedTags).toBe(1) // __paused
  })

  it('classifies firing timing via __e predicates and rules', () => {
    // tag0 (html) and tag2 (ua) fire on gtm.js → pageview; tag1 (gaawe) fires on
    // gtm.dom AND purchase → domReady + custom; tag3 (paused) has no rule.
    expect(container.firing.pageview).toBe(2)
    expect(container.firing.domReady).toBe(1)
    expect(container.firing.custom).toBe(1)
    expect(container.firing.unknown).toBe(1) // paused tag, no firing rule
    expect(container.firesOnPageview).toBe(2)
  })

  it('extracts vendor domains referenced inside Custom HTML', () => {
    expect(container.customHtmlVendors.map((v) => v.domain)).toContain('vendor-a.example')
  })

  it('labels tag types in the breakdown', () => {
    const labels = container.tagsByType.map((t) => t.label)
    expect(labels).toContain('Custom HTML')
    expect(labels).toContain('GA4 Event')
    expect(labels).toContain('Universal Analytics')
  })
})
