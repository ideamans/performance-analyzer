import type { AnalysisResult } from '../core/types.js'
import type { Reporter } from './Reporter.js'

/** Basic machine-readable reporter: pretty-printed AnalysisResult. */
export const jsonReporter: Reporter = {
  name: 'json',
  extension: 'json',
  render(result: AnalysisResult): string {
    return JSON.stringify(result, null, 2)
  },
}
