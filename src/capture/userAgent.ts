/**
 * User agents used for emulation.
 *
 * Lighthouse's mobile default is the Moto G Power (2022) string, which is the
 * exact UA PageSpeed Insights sends. Bot-protection vendors treat it as a
 * signature for automated auditing and block it: measured on real sites,
 * Akamai returns 403 for that UA while serving 200 to an iPhone Safari UA from
 * the same IP seconds later. A blocked run yields no trace at all, so the site
 * drops out of the population entirely.
 *
 * We therefore emulate a common real handset instead. This changes only the
 * UA string — viewport, device scale factor, CPU throttling and network
 * settings are untouched.
 *
 * Caveat: the viewport stays Lighthouse's mobile emulation (Moto G sized), so a
 * site doing UA-based device detection may serve a layout that does not match
 * the viewport. That is the price of being served at all.
 */

/** iPhone Safari. Common enough that blocking it would block real customers. */
export const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

/** Desktop Safari on macOS, for the same reason. */
export const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'

export function defaultUserAgent(device: 'mobile' | 'desktop'): string {
  return device === 'desktop' ? DESKTOP_USER_AGENT : MOBILE_USER_AGENT
}
