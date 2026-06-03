/**
 * Defensive parser for a GTM container body (gtm.js).
 *
 * The container embeds `var data = { "resource": {...} }` where `resource` holds
 * `tags`, `macros` (variables), `predicates` (conditions) and `rules` (which map
 * predicates → tags). The object is JSON-compatible, but tag bodies (vtp_html)
 * contain arbitrary HTML/JS with braces and quotes, so we extract the object
 * with a STRING-AWARE brace scanner (naive brace counting would mis-balance on
 * `{` inside custom HTML) and then JSON.parse. Anything unparseable degrades to
 * a null result rather than throwing.
 */

export interface GtmTag {
  function?: string
  [key: string]: unknown
}

export interface GtmResource {
  version?: string | number
  tags?: GtmTag[]
  macros?: Array<{ function?: string; [key: string]: unknown }>
  predicates?: Array<{ function?: string; arg0?: unknown; arg1?: unknown; [key: string]: unknown }>
  rules?: unknown[][]
}

/** Extract and parse `resource` from a gtm.js body. Returns null on failure. */
export function parseGtmResource(js: string): GtmResource | null {
  const m = /var\s+data\s*=\s*\{/.exec(js)
  if (!m) return null
  const braceIdx = js.indexOf('{', m.index)
  if (braceIdx < 0) return null
  const blob = extractObject(js, braceIdx)
  if (!blob) return null
  try {
    const data = JSON.parse(blob) as { resource?: GtmResource }
    return data.resource ?? null
  } catch {
    return null
  }
}

/** Slice a balanced `{...}` starting at `start`, skipping string contents. */
function extractObject(js: string, start: number): string {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < js.length; i++) {
    const c = js[i]!
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return js.slice(start, i + 1)
    }
  }
  return ''
}
