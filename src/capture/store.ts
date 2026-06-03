import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Artifacts, CaptureMeta, DevtoolsLog, LighthouseResult, Trace } from '../core/types.js'

const FILES = {
  meta: 'meta.json',
  trace: 'trace.json',
  devtoolsLog: 'devtoolslog.json',
  lhr: 'lhr.json',
} as const

/**
 * Persist a captured run as one directory:
 *   <runDir>/meta.json, trace.json, devtoolslog.json, lhr.json
 */
export async function saveArtifacts(runDir: string, artifacts: Artifacts): Promise<void> {
  await mkdir(runDir, { recursive: true })
  await Promise.all([
    writeJson(path.join(runDir, FILES.meta), artifacts.meta),
    writeJson(path.join(runDir, FILES.trace), artifacts.trace),
    writeJson(path.join(runDir, FILES.devtoolsLog), artifacts.devtoolsLog),
    writeJson(path.join(runDir, FILES.lhr), artifacts.lhr),
  ])
}

/** Load a previously captured run directory back into Artifacts. */
export async function loadArtifacts(runDir: string): Promise<Artifacts> {
  const [meta, trace, devtoolsLog, lhr] = await Promise.all([
    readJson<CaptureMeta>(path.join(runDir, FILES.meta)),
    readJson<Trace>(path.join(runDir, FILES.trace)),
    readJson<DevtoolsLog>(path.join(runDir, FILES.devtoolsLog)),
    readJson<LighthouseResult>(path.join(runDir, FILES.lhr)),
  ])
  return { meta, trace, devtoolsLog, lhr }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(data), 'utf8')
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T
}
