import { describe, expect, it } from 'vitest'

import { selectMedianRun } from './medianRun.js'
import type { SingleRun } from './runLighthouse.js'

function run(lcp: number | undefined): SingleRun {
  return {
    lhr: { lighthouseVersion: '12.8.2', audits: {} },
    trace: { traceEvents: [] },
    devtoolsLog: [],
    metrics: { largestContentfulPaint: lcp },
    lighthouseVersion: '12.8.2',
  }
}

describe('selectMedianRun', () => {
  it('throws when there are no runs', () => {
    expect(() => selectMedianRun([])).toThrow()
  })

  it('returns the only run for a single run', () => {
    const runs = [run(1000)]
    const selected = selectMedianRun(runs)
    expect(selected.index).toBe(0)
    expect(selected.run).toBe(runs[0])
  })

  it('picks the middle run by LCP for odd counts', () => {
    // LCPs: [300, 100, 200] -> sorted [100, 200, 300] -> median 200 (index 2)
    const runs = [run(300), run(100), run(200)]
    const selected = selectMedianRun(runs)
    expect(selected.index).toBe(2)
    expect(selected.run.metrics.largestContentfulPaint).toBe(200)
  })

  it('uses the lower-median for even counts', () => {
    // LCPs: [400, 100, 300, 200] -> sorted [100, 200, 300, 400]
    // lower-median position = floor((4-1)/2) = 1 -> value 200 (original index 3)
    const runs = [run(400), run(100), run(300), run(200)]
    const selected = selectMedianRun(runs)
    expect(selected.run.metrics.largestContentfulPaint).toBe(200)
    expect(selected.index).toBe(3)
  })

  it('treats runs missing LCP as worst (sorted last)', () => {
    // valid LCPs sort first; undefined -> Infinity sorts last
    const runs = [run(undefined), run(500), run(100)]
    const selected = selectMedianRun(runs)
    // sorted: [100, 500, Infinity] -> median index 1 -> value 500
    expect(selected.run.metrics.largestContentfulPaint).toBe(500)
  })
})
