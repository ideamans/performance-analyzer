import { parse } from 'acorn'

/**
 * Decode a GTM container body (gtm.js) into its `resource` config.
 *
 * The container assigns `var data = { resource: {...} }`. We parse the file with
 * a real JS parser (acorn), locate the `data` declarator, and evaluate ONLY its
 * literal AST (objects/arrays/strings/numbers/booleans/null) into a plain value.
 * If anything non-literal appears we bail to a string-aware JSON fallback. Both
 * paths are exact decodes — no interpretation. Returns null if neither works.
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

export interface ParseResult {
  resource: GtmResource
  parser: 'ast' | 'json'
}

export function parseGtmContainer(js: string): ParseResult | null {
  const viaAst = parseViaAst(js)
  if (viaAst) return { resource: viaAst, parser: 'ast' }
  const viaJson = parseViaJson(js)
  if (viaJson) return { resource: viaJson, parser: 'json' }
  return null
}

// --- AST path (acorn) -------------------------------------------------------

interface AstNode {
  type: string
  [key: string]: unknown
}

const NON_LITERAL = Symbol('non-literal')

function parseViaAst(js: string): GtmResource | null {
  let ast: AstNode
  try {
    ast = parse(js, { ecmaVersion: 'latest' }) as unknown as AstNode
  } catch {
    return null
  }
  const init = findDataInit(ast)
  if (!init) return null
  let value: unknown
  try {
    value = evalLiteral(init)
  } catch {
    return null // contained a non-literal node
  }
  if (!value || typeof value !== 'object') return null
  const resource = (value as { resource?: GtmResource }).resource
  return resource ?? null
}

/** Find the `data` variable's ObjectExpression init anywhere in the AST. */
function findDataInit(root: AstNode): AstNode | null {
  let found: AstNode | null = null
  const walk = (node: AstNode): void => {
    if (found) return
    if (
      node.type === 'VariableDeclarator' &&
      isNode(node.id) &&
      node.id.type === 'Identifier' &&
      (node.id as { name?: string }).name === 'data' &&
      isNode(node.init) &&
      node.init.type === 'ObjectExpression'
    ) {
      found = node.init
      return
    }
    for (const key of Object.keys(node)) {
      if (found) return
      const v = node[key]
      if (Array.isArray(v)) {
        for (const c of v) if (isNode(c)) walk(c)
      } else if (isNode(v)) {
        walk(v)
      }
    }
  }
  walk(root)
  return found
}

/** Evaluate a literal-only AST node to a JS value, else throw NON_LITERAL. */
function evalLiteral(node: AstNode): unknown {
  switch (node.type) {
    case 'Literal':
      return node.value
    case 'ObjectExpression': {
      const obj: Record<string, unknown> = {}
      for (const prop of node.properties as AstNode[]) {
        if (prop.type !== 'Property') throw NON_LITERAL // spread, etc.
        const keyNode = prop.key as AstNode
        const key =
          keyNode.type === 'Identifier'
            ? (keyNode.name as string)
            : keyNode.type === 'Literal'
              ? String(keyNode.value)
              : (() => {
                  throw NON_LITERAL
                })()
        obj[key] = evalLiteral(prop.value as AstNode)
      }
      return obj
    }
    case 'ArrayExpression':
      return (node.elements as Array<AstNode | null>).map((e) => (e === null ? null : evalLiteral(e)))
    case 'UnaryExpression': {
      if (node.operator === '-') {
        const arg = node.argument as AstNode
        if (arg.type === 'Literal' && typeof arg.value === 'number') return -arg.value
      }
      throw NON_LITERAL
    }
    default:
      throw NON_LITERAL
  }
}

function isNode(v: unknown): v is AstNode {
  return Boolean(v) && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string'
}

// --- JSON fallback (string-aware brace scan) --------------------------------

function parseViaJson(js: string): GtmResource | null {
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
