import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as chromeLauncher from 'chrome-launcher'

/**
 * Resolve a Chrome executable to drive Lighthouse, working in any environment:
 *   1. an installed Chrome (or the CHROME_PATH env), if present
 *   2. otherwise download Chrome-for-Testing via @puppeteer/browsers into a
 *      cache dir and return that path
 *
 * Returns undefined only if detection fails and a download can't be performed;
 * callers may then let chrome-launcher try its own auto-detection.
 */
export async function resolveChromePath(onLog?: (msg: string) => void): Promise<string | undefined> {
  const installed = detectInstalledChrome()
  if (installed) return installed
  return downloadChrome(onLog)
}

function detectInstalledChrome(): string | undefined {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  try {
    const installs = chromeLauncher.Launcher.getInstallations()
    if (installs.length > 0) return installs[0]
  } catch {
    // none found
  }
  return undefined
}

/** Download Chrome-for-Testing (stable) programmatically; cached for reuse. */
async function downloadChrome(onLog?: (msg: string) => void): Promise<string | undefined> {
  // Dynamic import so the analyze-only path never loads the installer.
  const { install, resolveBuildId, detectBrowserPlatform, computeExecutablePath, Browser } = await import(
    '@puppeteer/browsers'
  )
  const platform = detectBrowserPlatform()
  if (!platform) return undefined

  const cacheDir = path.join(os.homedir(), '.cache', 'third-party-analyzer', 'browsers')
  const buildId = await resolveBuildId(Browser.CHROME, platform, 'stable')

  const cachedPath = computeExecutablePath({ browser: Browser.CHROME, platform, buildId, cacheDir })
  if (existsSync(cachedPath)) return cachedPath

  onLog?.(`Chrome not found — downloading Chrome-for-Testing ${buildId} (one-time)…`)
  const installed = await install({ browser: Browser.CHROME, platform, buildId, cacheDir })
  return installed.executablePath
}
