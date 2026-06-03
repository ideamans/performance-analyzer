import type { Analyzer } from './Analyzer.js'
import { lcpAnalyzer } from './lcp/index.js'
import { thirdPartyAnalyzer } from './third-party/index.js'

/** All registered analyzers, keyed by name. Add new analyzers here. */
const analyzers = new Map<string, Analyzer>()

function register(a: Analyzer): void {
  analyzers.set(a.name, a)
}

register(lcpAnalyzer)
register(thirdPartyAnalyzer)

export function getAnalyzer(name: string): Analyzer | undefined {
  return analyzers.get(name)
}

export function analyzerNames(): string[] {
  return [...analyzers.keys()]
}
