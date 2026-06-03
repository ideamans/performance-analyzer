// third-party-web is CommonJS; Node ESM can't bind its named exports, so import
// the module object and destructure the functions.
import thirdPartyWeb from 'third-party-web'

const { getEntity, getRootDomain } = thirdPartyWeb

/**
 * Classify a resource for third-party-tag analysis (idea.md §4.1).
 *
 *   first  — same registrable domain as the measured page (incl. subdomains)
 *   tag    — a real third-party tag we care about (analytics, ads, pixels,
 *            A/B, chat, tag managers, social, AND external web fonts)
 *   cdnLib — public CDN library load (jsDelivr/cdnjs/unpkg/jquery/Google CDN…),
 *            EXCLUDED from "tags" because it's trivially self-hostable
 *
 * third-party-web's `cdn` category does most of the CDN detection; Google Fonts
 * is force-included as a tag (it's `cdn` in TPW but matters for rendering).
 */
export type TagKind = 'first' | 'tag' | 'cdnLib'

export interface Classification {
  kind: TagKind
  rootDomain: string
  entity: string
  category: string
  /** third-party-web's industry-average main-thread execution time for this entity (ms). */
  avgExecutionMs?: number
}

/** External web fonts — kept as tags (rule), though TPW marks them `cdn`. */
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com'])

/** Backup list for public CDN libraries (TPW `cdn` category covers most). */
const CDN_LIB_HOSTS = new Set([
  'ajax.googleapis.com',
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'jsdelivr.net',
  'unpkg.com',
  'code.jquery.com',
  'stackpath.bootstrapcdn.com',
  'maxcdn.bootstrapcdn.com',
  'cdn.bootcss.com',
  'ajax.aspnetcdn.com',
  'cdn.skypack.dev',
  'esm.sh',
])

/** A plausible registrable domain: labels + a TLD, nothing path-like. */
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i

export function classifyResource(url: string, host: string, measuredRoot: string): Classification {
  // getRootDomain can return junk for odd URLs; fall back to the host.
  const raw = safeRoot(url)
  const rootDomain = DOMAIN_RE.test(raw) ? raw : host || raw

  if (rootDomain && measuredRoot && rootDomain === measuredRoot) {
    return { kind: 'first', rootDomain, entity: 'First Party', category: 'first-party' }
  }

  const entity = getEntity(url)
  // averageExecutionTime can be NaN for some entities — Number.isFinite guards it
  // (typeof NaN === 'number', so a plain typeof check would leak NaN).
  const avg = entity?.averageExecutionTime
  const avgExecutionMs = typeof avg === 'number' && Number.isFinite(avg) ? avg : undefined

  if (FONT_HOSTS.has(host)) {
    return { kind: 'tag', rootDomain, entity: 'Google Fonts', category: 'font', avgExecutionMs }
  }

  const category = entity?.category ?? entity?.categories?.[0] ?? 'unknown'

  if (category === 'cdn' || CDN_LIB_HOSTS.has(host)) {
    return { kind: 'cdnLib', rootDomain, entity: entity?.name ?? rootDomain, category: 'cdn', avgExecutionMs }
  }

  return { kind: 'tag', rootDomain, entity: entity?.name ?? rootDomain, category, avgExecutionMs }
}

/** The measured page's registrable domain, used for first-party detection. */
export function measuredRootDomain(url: string): string {
  return safeRoot(url)
}

function safeRoot(url: string): string {
  try {
    return getRootDomain(url) ?? ''
  } catch {
    return ''
  }
}
