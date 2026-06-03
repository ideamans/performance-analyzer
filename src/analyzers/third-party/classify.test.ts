import { describe, expect, it } from 'vitest'

import { classifyResource, measuredRootDomain } from './classify.js'

const SITE = 'example.com'

function classify(url: string): ReturnType<typeof classifyResource> {
  const host = new URL(url).hostname
  return classifyResource(url, host, SITE)
}

describe('classifyResource', () => {
  it('treats the page eTLD+1 (incl. subdomains) as first party', () => {
    expect(classify('https://www.example.com/app.js').kind).toBe('first')
    expect(classify('https://cdn.example.com/x.png').kind).toBe('first')
  })

  it('counts analytics / ads / tag managers / social as tags', () => {
    expect(classify('https://www.googletagmanager.com/gtm.js?id=GTM-X').kind).toBe('tag')
    expect(classify('https://connect.facebook.net/en_US/fbevents.js').kind).toBe('tag')
    expect(classify('https://cdn.karte.io/x.js').kind).toBe('tag')
  })

  it('includes Google Fonts as a tag (category=font), not a CDN library', () => {
    const css = classify('https://fonts.googleapis.com/css?family=Roboto')
    expect(css.kind).toBe('tag')
    expect(css.category).toBe('font')
    const file = classify('https://fonts.gstatic.com/s/roboto/x.woff2')
    expect(file.kind).toBe('tag')
    expect(file.category).toBe('font')
  })

  it('EXCLUDES public CDN libraries (replaceable by self-hosting)', () => {
    // ajax.googleapis.com is the JS-library CDN — distinct from Google Fonts.
    expect(classify('https://ajax.googleapis.com/ajax/libs/jquery/3.6.0/jquery.min.js').kind).toBe('cdnLib')
    expect(classify('https://cdn.jsdelivr.net/npm/vue').kind).toBe('cdnLib')
    expect(classify('https://code.jquery.com/jquery-3.6.0.min.js').kind).toBe('cdnLib')
    expect(classify('https://cdnjs.cloudflare.com/ajax/libs/x/x.js').kind).toBe('cdnLib')
  })

  it('distinguishes fonts.googleapis.com from ajax.googleapis.com by host', () => {
    expect(classify('https://fonts.googleapis.com/css?family=A').kind).toBe('tag')
    expect(classify('https://ajax.googleapis.com/ajax/libs/x/x.js').kind).toBe('cdnLib')
  })

  it('classifies unknown third parties as tags', () => {
    const c = classify('https://some-unknown-tracker-xyz.com/pixel.gif')
    expect(c.kind).toBe('tag')
  })
})

describe('measuredRootDomain', () => {
  it('returns the registrable domain', () => {
    expect(measuredRootDomain('https://www.example.com/path')).toBe('example.com')
  })
})
