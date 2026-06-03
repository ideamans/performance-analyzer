#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { analyze } from './analyze.js'
import { analyzerNames } from './analyzers/registry.js'
import { capture } from './capture/index.js'
import type { Device } from './core/types.js'
import { getReporter, reporterNames } from './report/registry.js'

function printUsage(): void {
  console.log(`performance-analyzer

Usage:
  performance-analyzer capture <url> --out <dir> [options]
  performance-analyzer analyze <angle> <runDir> [options]

capture options:
  --out <dir>        Output directory for the captured run (required)
  --device <d>       mobile | desktop            (default: mobile)
  --runs <n>         Number of runs; median by LCP kept (default: 3)
  --log-level <l>    silent|error|warn|info|verbose (default: error)

analyze options:
  <angle>            ${analyzerNames().join(' | ')}
  <runDir>           Directory of a captured run
  --format <list>    Comma-separated: ${reporterNames().join(',')}  (default: json)
  --out <dir>        Where to write report files (default: <runDir>)
  --stdout           Print to stdout instead of writing files

  -h, --help         Show this help
`)
}

interface ParsedArgs {
  command?: string
  positionals: string[]
  options: Record<string, string>
  flags: Set<string>
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const options: Record<string, string> = {}
  const flags = new Set<string>()

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '-h' || arg === '--help') {
      flags.add('help')
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        options[key] = next
        i++
      } else {
        flags.add(key)
      }
    } else {
      positionals.push(arg)
    }
  }

  const [command, ...rest] = positionals
  return { command, positionals: rest, options, flags }
}

async function runAnalyze(args: ParsedArgs): Promise<void> {
  const angle = args.positionals[0]
  const runDir = args.positionals[1]
  if (!angle || !runDir) {
    console.error('Error: usage: analyze <angle> <runDir> [--format json] [--out dir] [--stdout]')
    process.exitCode = 1
    return
  }

  const formats = (args.options.format ?? 'json').split(',').map((s) => s.trim()).filter(Boolean)
  const reporters = formats.map((f) => ({ name: f, reporter: getReporter(f) }))
  const missing = reporters.filter((r) => !r.reporter).map((r) => r.name)
  if (missing.length > 0) {
    console.error(`Error: unknown format(s): ${missing.join(', ')}. Available: ${reporterNames().join(', ')}`)
    process.exitCode = 1
    return
  }

  const resolvedRunDir = path.resolve(runDir)
  const result = await analyze(angle, resolvedRunDir, {
    logger: { info: (m) => console.error(m), warn: (m) => console.error(`WARN: ${m}`) },
  })

  const toStdout = args.flags.has('stdout')
  const outDir = path.resolve(args.options.out ?? resolvedRunDir)
  if (!toStdout) await mkdir(outDir, { recursive: true })

  for (const { reporter } of reporters) {
    const text = reporter!.render(result)
    if (toStdout) {
      process.stdout.write(text + '\n')
    } else {
      const file = path.join(outDir, `${angle}.${reporter!.extension}`)
      await writeFile(file, text, 'utf8')
      console.error(`Wrote ${file}`)
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.flags.has('help') || !args.command) {
    printUsage()
    process.exitCode = args.command ? 0 : 1
    return
  }

  if (args.command === 'analyze') {
    await runAnalyze(args)
    return
  }

  if (args.command !== 'capture') {
    console.error(`Unknown command: ${args.command}`)
    printUsage()
    process.exitCode = 1
    return
  }

  const url = args.positionals[0]
  if (!url) {
    console.error('Error: <url> is required')
    process.exitCode = 1
    return
  }

  const outDir = args.options.out
  if (!outDir) {
    console.error('Error: --out <dir> is required')
    process.exitCode = 1
    return
  }

  const device = (args.options.device ?? 'mobile') as Device
  if (device !== 'mobile' && device !== 'desktop') {
    console.error(`Error: --device must be 'mobile' or 'desktop'`)
    process.exitCode = 1
    return
  }

  const runs = args.options.runs ? Number(args.options.runs) : undefined
  if (runs !== undefined && (!Number.isInteger(runs) || runs < 1)) {
    console.error('Error: --runs must be a positive integer')
    process.exitCode = 1
    return
  }

  const resolvedOut = path.resolve(outDir)
  console.error(`Capturing ${url} (device=${device}, runs=${runs ?? 3}) -> ${resolvedOut}`)

  const artifacts = await capture(url, {
    device,
    runs,
    outDir: resolvedOut,
    logLevel: (args.options['log-level'] as never) ?? 'error',
    onRun: (index, total, run) => {
      const lcp = run.metrics.largestContentfulPaint
      console.error(`  run ${index}/${total}: LCP=${lcp ? Math.round(lcp) + 'ms' : 'n/a'}`)
    },
  })

  const m = artifacts.meta.metrics
  console.error(
    `Done. selected run #${artifacts.meta.selectedRunIndex + 1}/${artifacts.meta.runs} ` +
      `(FCP=${fmt(m.firstContentfulPaint)}, LCP=${fmt(m.largestContentfulPaint)}, TTFB=${fmt(m.timeToFirstByte)})`,
  )
  console.error(`Artifacts written to ${resolvedOut}`)
}

function fmt(ms?: number): string {
  return typeof ms === 'number' ? `${Math.round(ms)}ms` : 'n/a'
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err)
  process.exitCode = 1
})
