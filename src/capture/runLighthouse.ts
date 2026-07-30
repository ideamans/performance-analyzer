import * as chromeLauncher from 'chrome-launcher'

import { resolveChromePath } from './browser.js'
import { THROTTLING } from './throttling.js'

import type {
  Device,
  DevtoolsLog,
  KeyMetrics,
  LighthouseResult,
  Trace,
} from '../core/types.js'

export interface RunOptions {
  device: Device
  /**
   * URL glob patterns to block during the run (Lighthouse passes these to
   * `Network.setBlockedURLs`). Blocked requests FAIL (ERR_BLOCKED_BY_CLIENT)
   * rather than returning an empty body — good enough for an upper-bound
   * "what if these tags were gone" experiment. See ablate.ts.
   */
  blockedUrlPatterns?: string[]
  /** Extra Chrome flags (e.g. for CI). Headless is added automatically. */
  chromeFlags?: string[]
  /** Lighthouse log level. Default: 'error'. */
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'verbose'
  /** Progress messages (e.g. Chrome download). */
  onLog?: (msg: string) => void
}

/** Result of a single Lighthouse run, before persistence. */
export interface SingleRun {
  lhr: LighthouseResult
  trace: Trace
  devtoolsLog: DevtoolsLog
  metrics: KeyMetrics
  finalUrl?: string
  lighthouseVersion: string
}

/**
 * Run Lighthouse once for the performance category only, returning the raw
 * trace and devtoolslog alongside the lhr. Mobile uses Lighthouse defaults;
 * desktop uses the bundled desktop preset.
 */
export async function runLighthouse(url: string, opts: RunOptions): Promise<SingleRun> {
  // Lighthouse is imported lazily so the analyze-only commands stay pure JS and
  // can be compiled to a standalone binary (Lighthouse loads runtime assets that
  // don't survive bundling). Capture pulls it in only when actually invoked.
  let lighthouse: typeof import('lighthouse').default
  let desktopConfig: typeof import('lighthouse/core/config/desktop-config.js').default
  try {
    const [lh, dc] = await Promise.all([import('lighthouse'), import('lighthouse/core/config/desktop-config.js')])
    lighthouse = lh.default
    desktopConfig = dc.default
  } catch (err) {
    throw new Error(
      'Lighthouse failed to load. `capture` is not supported from a compiled single ' +
        'binary (Lighthouse reads runtime assets that bundling drops) — run `capture` ' +
        'via `bun`/`node` with dependencies installed. The `analyze` commands work ' +
        `standalone. Original error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const chromePath = await resolveChromePath(opts.onLog)
  const chrome = await chromeLauncher.launch({
    chromePath,
    chromeFlags: ['--headless=new', ...(opts.chromeFlags ?? [])],
  })

  try {
    const flags = {
      port: chrome.port,
      onlyCategories: ['performance'],
      output: 'json' as const,
      logLevel: opts.logLevel ?? ('error' as const),
      // Applied (DevTools) throttling, NOT Lantern simulation. This makes the
      // recorded trace reflect the real throttled experience: observed FCP/LCP
      // in the trace equal the reported metrics, so window aggregations
      // ("what happens before FCP/LCP") are honest rather than measured on a
      // near-unthrottled fast-machine timeline. See architecture.md §8.
      throttlingMethod: 'devtools' as const,
      // CPU 4x but wide network — see throttling.ts for the rationale.
      throttling: { ...THROTTLING },
      ...(opts.blockedUrlPatterns?.length ? { blockedUrlPatterns: opts.blockedUrlPatterns } : {}),
    }

    // Mobile is the Lighthouse default config; desktop needs the preset.
    // The throttlingMethod flag above overrides the config's default.
    const config = opts.device === 'desktop' ? desktopConfig : undefined

    const result = await lighthouse(url, flags, config)
    if (!result) {
      throw new Error(`Lighthouse returned no result for ${url}`)
    }

    const lhr = result.lhr as unknown as LighthouseResult
    const artifacts = result.artifacts as unknown as Record<string, unknown>

    return {
      lhr,
      trace: extractTrace(artifacts),
      devtoolsLog: extractDevtoolsLog(artifacts),
      metrics: extractMetrics(lhr),
      finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl,
      lighthouseVersion: lhr.lighthouseVersion,
    }
  } finally {
    await chrome.kill()
  }
}

/**
 * Pull the trace out of Lighthouse artifacts. Lighthouse 10+ exposes `Trace`,
 * but fall back to the legacy `traces.defaultPass` shape just in case.
 */
function extractTrace(artifacts: Record<string, unknown>): Trace {
  const direct = artifacts.Trace as Trace | undefined
  if (direct?.traceEvents) return direct

  const legacy = (artifacts.traces as Record<string, Trace> | undefined)?.defaultPass
  if (legacy?.traceEvents) return legacy

  throw new Error('Could not find a trace in Lighthouse artifacts')
}

function extractDevtoolsLog(artifacts: Record<string, unknown>): DevtoolsLog {
  const direct = artifacts.DevtoolsLog as DevtoolsLog | undefined
  if (Array.isArray(direct)) return direct

  const legacy = (artifacts.devtoolsLogs as Record<string, DevtoolsLog> | undefined)?.defaultPass
  if (Array.isArray(legacy)) return legacy

  throw new Error('Could not find a devtoolslog in Lighthouse artifacts')
}

/** Read headline metrics from the `metrics` audit (values are in ms). */
function extractMetrics(lhr: LighthouseResult): KeyMetrics {
  const items = lhr.audits?.metrics?.details?.items
  const m = (Array.isArray(items) ? items[0] : undefined) as Partial<KeyMetrics> | undefined
  return {
    timeToFirstByte: m?.timeToFirstByte,
    firstContentfulPaint: m?.firstContentfulPaint,
    largestContentfulPaint: m?.largestContentfulPaint,
    speedIndex: m?.speedIndex,
    totalBlockingTime: m?.totalBlockingTime,
    cumulativeLayoutShift: m?.cumulativeLayoutShift,
    interactive: m?.interactive,
  }
}
