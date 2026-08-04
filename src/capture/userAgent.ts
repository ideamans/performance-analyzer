/**
 * Alternative user agents for sites that block the default.
 *
 * **The default stays Lighthouse's own** (Moto G Power 2022 on mobile), because
 * that is what PageSpeed Insights reports and what most sites are measured
 * against — switching it wholesale would make results incomparable with every
 * dataset gathered so far.
 *
 * Some sites block that string specifically, though: bot-protection vendors
 * treat it as an automated-auditing signature. Measured on real sites, Akamai
 * returns 403 for it while serving 200 to an iPhone Safari UA from the same IP
 * seconds later, and a blocked run yields no trace at all — the site drops out
 * of the population rather than failing loudly. Pass `userAgent` for those.
 *
 * Only the UA string changes; viewport, device scale factor, CPU throttling and
 * network settings are untouched. Note the viewport still reflects Lighthouse's
 * mobile emulation, so a site doing UA-based device detection may serve a layout
 * that does not match it.
 */

/** iPhone Safari. Common enough that blocking it would block real customers. */
export const IPHONE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

/** Desktop Safari on macOS, for the same reason. */
export const MAC_SAFARI_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
