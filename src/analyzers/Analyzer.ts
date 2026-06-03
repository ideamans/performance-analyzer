import type { AnalysisResult, Artifacts, Derived } from '../core/types.js'

/** Minimal logger an analyzer can use; defaults to console in the CLI. */
export interface Logger {
  info(msg: string): void
  warn(msg: string): void
}

/** Everything an analyzer receives. `fetch` is for analyzers that need HTTP (GTM). */
export interface AnalyzerContext {
  artifacts: Artifacts
  derived: Derived
  fetch: typeof fetch
  logger: Logger
}

export interface Analyzer<R = unknown> {
  /** Stable name used on the CLI and in the registry (e.g. "lcp"). */
  name: string
  /** Analyze the same artifacts from this angle. Pure unless it needs HTTP. */
  analyze(ctx: AnalyzerContext): Promise<AnalysisResult<R>>
}
