import { describe, expect, it } from 'vitest'

import { analyzeContainer } from './analyze.js'
import { parseGtmContainer } from './parse.js'

// Minimal realistic gtm.js. macro 0 = Event(__e); predicates compare it to
// gtm.js / gtm.dom / purchase. The custom HTML references a KNOWN vendor domain
// (Facebook) and embeds a brace+quote to exercise the parser.
const SAMPLE = `
window.google_tag_manager = {};
var data = {
  "resource": {
    "version": "42",
    "macros": [ {"function":"__e"}, {"function":"__v","vtp_name":"x"} ],
    "tags": [
      {"function":"__html","vtp_html":"<script>var o={a:1};fbq('init');s='https://connect.facebook.net/en_US/fbevents.js?x={a}'</script>"},
      {"function":"__gaawe","vtp_eventName":"page_view"},
      {"function":"__ua","vtp_trackType":"TRACK_PAGEVIEW"},
      {"function":"__paused","vtp_originalTagType":"html"}
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

describe('parseGtmContainer', () => {
  it('decodes the container via AST', () => {
    const r = parseGtmContainer(SAMPLE)
    expect(r).not.toBeNull()
    expect(r!.parser).toBe('ast')
    expect(r!.resource.version).toBe('42')
    expect(r!.resource.tags).toHaveLength(4)
  })

  it('handles braces/quotes inside Custom HTML', () => {
    const r = parseGtmContainer(SAMPLE)
    expect(r!.resource.tags![0]!.function).toBe('__html')
  })

  it('returns null when there is no container body', () => {
    expect(parseGtmContainer('console.log("nope")')).toBeNull()
  })
})

describe('analyzeContainer', () => {
  const c = analyzeContainer(parseGtmContainer(SAMPLE)!.resource)

  it('counts custom HTML, legacy UA and paused tags', () => {
    expect(c.customHtml).toBe(1)
    expect(c.legacyUa).toBe(1)
    expect(c.pausedTags).toBe(1)
  })

  it('classifies tags MECE: firing + control + paused === total', () => {
    // html, gaawe, ua = firing; paused = paused; no listeners here.
    expect(c.tagClass).toEqual({ firing: 3, control: 0, paused: 1 })
    expect(c.tagClass.firing + c.tagClass.control + c.tagClass.paused).toBe(c.tags)
  })

  it('classifies firing via __e predicates and `if` rules', () => {
    expect(c.firing.pageview).toBe(2) // html + ua on gtm.js
    expect(c.firing.domReady).toBe(1) // gaawe on gtm.dom
    expect(c.firing.custom).toBe(1) // gaawe on purchase
    expect(c.firing.unknown).toBe(1) // paused, no rule
    expect(c.firesOnPageview).toBe(2)
  })

  it('attributes tags to vendors (config domain + template type)', () => {
    const m = new Map(c.tagsByVendor.map((v) => [v.key, v.count]))
    expect(m.get('Facebook')).toBe(1) // from the domain in Custom HTML
    expect(m.get('Google Analytics')).toBe(2) // __gaawe + __ua by template type
  })

  it('labels tag types', () => {
    const labels = c.tagsByType.map((t) => t.label)
    expect(labels).toContain('Custom HTML')
    expect(labels).toContain('GA4 Event')
    expect(labels).toContain('Universal Analytics')
  })
})
