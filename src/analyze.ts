import { loadArtifacts } from './capture/store.js'
import { buildDerived } from './core/derived.js'
import type { AnalysisResult } from './core/types.js'
import type { Logger } from './analyzers/Analyzer.js'
import { getAnalyzer } from './analyzers/registry.js'

export interface AnalyzeOptions {
  /** Injected for analyzers that need HTTP (e.g. GTM). Defaults to global fetch. */
  fetch?: typeof fetch
  logger?: Logger
}

const silentLogger: Logger = { info: () => {}, warn: () => {} }

/**
 * Load a captured run, build the derived model once, and run one analyzer
 * against it. Pure aside from the analyzer's own side effects (GTM HTTP).
 */
export async function analyze(
  analyzerName: string,
  runDir: string,
  opts: AnalyzeOptions = {},
): Promise<AnalysisResult> {
  const analyzer = getAnalyzer(analyzerName)
  if (!analyzer) {
    throw new Error(`Unknown analyzer: ${analyzerName}`)
  }
  const artifacts = await loadArtifacts(runDir)
  const derived = buildDerived(artifacts)
  return analyzer.analyze({
    artifacts,
    derived,
    fetch: opts.fetch ?? fetch,
    logger: opts.logger ?? silentLogger,
  })
}
