import { describe, expect, it } from 'vitest'

import { computeDeltas, tagBlockTargets, type AblateSide } from './ablate.js'
import type { Artifacts } from './core/types.js'

/** Minimal artifacts: tagBlockTargets only needs meta + the network audit. */
function artifactsWith(urls: string[]): Artifacts {
  return {
    meta: {
      url: 'https://www.example.com/',
      finalUrl: 'https://www.example.com/',
      device: 'mobile',
      throttling: {},
      capturedAt: '2026-01-01T00:00:00.000Z',
      lighthouseVersion: '12.0.0',
      runs: 1,
      selectedRunIndex: 0,
      metrics: {},
    },
    trace: { traceEvents: [] },
    devtoolsLog: [],
    lhr: {
      lighthouseVersion: '12.0.0',
      audits: {
        'network-requests': {
          id: 'network-requests',
          score: null,
          details: {
            items: urls.map((url) => ({
              url,
              networkRequestTime: 0,
              networkEndTime: 10,
              transferSize: 100,
              resourceSize: 100,
              statusCode: 200,
              resourceType: 'Script',
            })),
          },
        },
      },
    },
  }
}

function side(over: Partial<AblateSide>): AblateSide {
  return { runDir: '', requests: 0, transferKB: 0, tagRequests: 0, failedRequests: 0, ...over }
}

describe('tagBlockTargets', () => {
  it('blocks tag hosts and their registrable domain, but not first party or CDN libs', () => {
    const { domains, patterns } = tagBlockTargets(
      artifactsWith([
        'https://www.example.com/app.js',
        'https://www.googletagmanager.com/gtm.js?id=GTM-X',
        'https://cdn.jsdelivr.net/npm/vue',
      ]),
    )

    expect(domains).toEqual(['www.googletagmanager.com'])
    // exact host + registrable domain + its subdomain wildcard
    expect(patterns).toContain('*://www.googletagmanager.com/*')
    expect(patterns).toContain('*://googletagmanager.com/*')
    expect(patterns).toContain('*://*.googletagmanager.com/*')
    expect(patterns.some((p) => p.includes('example.com'))).toBe(false)
    expect(patterns.some((p) => p.includes('jsdelivr'))).toBe(false)
  })

  it('includes Google Fonts (it is a tag by rule) and dedupes hosts', () => {
    const { domains } = tagBlockTargets(
      artifactsWith([
        'https://fonts.googleapis.com/css?family=Roboto',
        'https://www.googletagmanager.com/gtm.js?id=A',
        'https://www.googletagmanager.com/gtm.js?id=B',
      ]),
    )
    expect(domains).toEqual(['fonts.googleapis.com', 'www.googletagmanager.com'])
  })
})

describe('computeDeltas', () => {
  it('reports blocked - baseline, so improvements are negative', () => {
    const rows = computeDeltas(side({ lcpMs: 4000 }), side({ lcpMs: 3000 }))
    const lcp = rows.find((r) => r.metric === 'lcpMs')
    expect(lcp).toMatchObject({ baseline: 4000, blocked: 3000, delta: -1000, deltaPct: -25 })
  })

  it('computes the percentage from raw values (a CLS going to zero is -100%)', () => {
    const rows = computeDeltas(side({ cls: 0.0585 }), side({ cls: 0 }))
    expect(rows.find((r) => r.metric === 'cls')?.deltaPct).toBe(-100)
  })

  it('leaves delta undefined when a metric is missing rather than guessing zero', () => {
    const rows = computeDeltas(side({ tbtMs: 500 }), side({}))
    const tbt = rows.find((r) => r.metric === 'tbtMs')
    expect(tbt?.delta).toBeUndefined()
    expect(tbt?.deltaPct).toBeUndefined()
  })

  it('skips the percentage when the baseline is zero (no division by zero)', () => {
    const rows = computeDeltas(side({ cls: 0 }), side({ cls: 0.1 }))
    const cls = rows.find((r) => r.metric === 'cls')
    expect(cls?.delta).toBe(0.1)
    expect(cls?.deltaPct).toBeUndefined()
  })
})
