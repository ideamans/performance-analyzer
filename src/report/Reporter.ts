import type { AnalysisResult } from '../core/types.js'

export interface Reporter {
  /** Stable name used on the CLI and in the registry (e.g. "json"). */
  name: string
  /** File extension for written output (no dot). */
  extension: string
  /** Render one analyzer's result to a string. */
  render(result: AnalysisResult): string
}
