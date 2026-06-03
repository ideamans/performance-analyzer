import { jsonReporter } from './json.js'
import type { Reporter } from './Reporter.js'

/** All registered reporters, keyed by name. Add new formats here. */
const reporters = new Map<string, Reporter>()

function register(r: Reporter): void {
  reporters.set(r.name, r)
}

register(jsonReporter)

export function getReporter(name: string): Reporter | undefined {
  return reporters.get(name)
}

export function reporterNames(): string[] {
  return [...reporters.keys()]
}
