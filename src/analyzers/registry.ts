import type { Analyzer } from './Analyzer.js'
import { gtmAnalyzer } from './gtm/index.js'
import { lcpAnalyzer } from './lcp/index.js'
import { thirdPartyAnalyzer } from './third-party/index.js'

/** All registered analyzers, keyed by name. Add new analyzers here. */
const analyzers = new Map<string, Analyzer>()

function register(a: Analyzer): void {
  analyzers.set(a.name, a)
}

// Registration order is the order the angles are presented in: third-party is
// the main theme, gtm explains where the tags come from, lcp is the bonus angle.
register(thirdPartyAnalyzer)
register(gtmAnalyzer)
register(lcpAnalyzer)

export function getAnalyzer(name: string): Analyzer | undefined {
  return analyzers.get(name)
}

export function analyzerNames(): string[] {
  return [...analyzers.keys()]
}
