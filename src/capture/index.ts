import type { Artifacts, CaptureMeta, Device } from '../core/types.js'
import { selectMedianRun } from './medianRun.js'
import { runLighthouse, type SingleRun } from './runLighthouse.js'
import { saveArtifacts } from './store.js'
import { THROTTLING, THROTTLING_DESCRIPTION } from './throttling.js'

export interface CaptureOptions {
  device?: Device
  /** Number of Lighthouse runs; the median (by LCP) is selected. Default: 3. */
  runs?: number
  /** If set, the captured artifacts are written to this directory. */
  outDir?: string
  chromeFlags?: string[]
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'verbose'
  /** Called after each run completes (1-based index), for progress reporting. */
  onRun?: (index: number, total: number, run: SingleRun) => void
  /** Progress messages (e.g. Chrome download). */
  onLog?: (msg: string) => void
}

/**
 * Capture a URL with Lighthouse (performance only), running it `runs` times and
 * keeping the median run by LCP. Optionally persists to `outDir`.
 */
export async function capture(url: string, opts: CaptureOptions = {}): Promise<Artifacts> {
  const device: Device = opts.device ?? 'mobile'
  const total = Math.max(1, opts.runs ?? 3)

  const runs: SingleRun[] = []
  for (let i = 0; i < total; i++) {
    const run = await runLighthouse(url, {
      device,
      chromeFlags: opts.chromeFlags,
      logLevel: opts.logLevel,
      onLog: opts.onLog,
    })
    runs.push(run)
    opts.onRun?.(i + 1, total, run)
  }

  const selected = selectMedianRun(runs)

  const meta: CaptureMeta = {
    url,
    finalUrl: selected.run.finalUrl,
    device,
    throttling: { method: 'devtools', description: THROTTLING_DESCRIPTION, ...THROTTLING },
    capturedAt: new Date().toISOString(),
    lighthouseVersion: selected.run.lighthouseVersion,
    runs: total,
    selectedRunIndex: selected.index,
    metrics: selected.run.metrics,
  }

  const artifacts: Artifacts = {
    meta,
    trace: selected.run.trace,
    devtoolsLog: selected.run.devtoolsLog,
    lhr: selected.run.lhr,
  }

  if (opts.outDir) {
    await saveArtifacts(opts.outDir, artifacts)
  }

  return artifacts
}

export { selectMedianRun } from './medianRun.js'
export { runLighthouse } from './runLighthouse.js'
export { loadArtifacts, saveArtifacts } from './store.js'
export type { SingleRun } from './runLighthouse.js'
