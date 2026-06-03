import type { SingleRun } from './runLighthouse.js'

export interface SelectedRun {
  run: SingleRun
  index: number
  /** All runs in capture order (for diagnostics). */
  all: SingleRun[]
}

/**
 * Pick the representative run: the one whose LCP is the lower-median across
 * runs. We select a whole real run (not synthesized per-metric medians) so the
 * trace and the headline numbers stay consistent for downstream analyzers.
 *
 * Runs missing an LCP value sort last (treated as worst).
 */
export function selectMedianRun(runs: SingleRun[]): SelectedRun {
  if (runs.length === 0) {
    throw new Error('selectMedianRun: no runs provided')
  }

  const ordered = runs
    .map((run, index) => ({ run, index, lcp: lcpOf(run) }))
    .sort((a, b) => a.lcp - b.lcp)

  // Lower-median: for even counts, take the lower of the two middle elements.
  const medianPos = Math.floor((ordered.length - 1) / 2)
  const picked = ordered[medianPos]!

  return { run: picked.run, index: picked.index, all: runs }
}

function lcpOf(run: SingleRun): number {
  const lcp = run.metrics.largestContentfulPaint
  return typeof lcp === 'number' && Number.isFinite(lcp) ? lcp : Number.POSITIVE_INFINITY
}
