/**
 * Help text. Short `--help` is context-aware; long `--llm` emits detailed,
 * LLM-oriented docs including how to read the output data. All in English.
 */

export const SHORT_HELP = `performance-analyzer — capture a Lighthouse trace once, analyze it from multiple angles.

USAGE
  performance-analyzer <command> [options]

COMMANDS
  capture <url> --out <dir>     Measure a URL and save raw artifacts
  analyze <angle> <runDir>      Analyze saved artifacts from one angle

ANGLES (for analyze)
  lcp           What happens / obstructs / is slow on the way to LCP
  third-party   Third-party tag volume, CPU, vendor breakdown
  gtm           GTM container bloat (fetches gtm.js live)

GLOBAL
  -h, --help    Show help. Context-aware: \`<command> --help\`
  --llm         Long, LLM-oriented help incl. how to read the output.
                Per command/angle, e.g. \`analyze lcp --llm\`. Bare \`--llm\` = everything.

EXAMPLES
  performance-analyzer capture https://example.com --out ./runs/site --device mobile --runs 3
  performance-analyzer analyze lcp ./runs/site --stdout
  performance-analyzer analyze third-party ./runs/site --format json --out ./reports

See \`performance-analyzer <command> --help\` for options,
or \`performance-analyzer <command|angle> --llm\` for full docs + data interpretation.`

export const CAPTURE_HELP = `capture — measure a URL with Lighthouse (performance category only) and save raw artifacts.

USAGE
  performance-analyzer capture <url> --out <dir> [options]

OPTIONS
  --out <dir>       Output directory (required). Writes: meta.json, trace.json,
                    devtoolslog.json, lhr.json (one run = one directory)
  --device <d>      mobile | desktop                       (default: mobile)
  --runs <n>        Run N times; keep the median run by LCP (default: 3)
  --log-level <l>   silent|error|warn|info|verbose         (default: error)
  -h, --help        Show this help        |  --llm  Full docs

NOTES
  - Throttling is APPLIED (DevTools): mobile, CPU 4x, network ~100Mbps, ~0ms latency.
    The recorded trace IS the throttled experience (reported == observed FCP/LCP).
  - Chrome is auto-detected, or auto-downloaded (Chrome-for-Testing) if missing.`

export const ANALYZE_HELP = `analyze — analyze saved artifacts from one angle.

USAGE
  performance-analyzer analyze <angle> <runDir> [options]

ANGLES
  lcp | third-party | gtm

OPTIONS
  --format <list>   Comma-separated reporters: json    (default: json)
  --out <dir>       Where to write report files        (default: <runDir>)
  --stdout          Print to stdout instead of writing files
  -h, --help        Show this help        |  --llm  Full docs + how to read data

For the meaning of every output field, run:
  performance-analyzer analyze <angle> --llm`

const LLM_OVERVIEW = `# performance-analyzer — LLM guide

## Purpose
A benchmarking / self-reflection tool: capture a FAST competitor and your own
SLOW site under identical conditions, then read the reports side by side to see
WHERE and WHY they differ. There is no automatic "compare" command by design —
you produce one report per site and compare them (an LLM is well suited to this).

## Model: capture once, analyze from many angles
1) capture: run Lighthouse ONCE, save raw artifacts (trace, devtoolslog, lhr, meta).
2) analyze: run pure analyzers over the SAME artifacts (lcp, third-party, gtm).
Re-analyze freely without re-measuring.

## Measurement conditions (important for fair comparison)
- APPLIED (DevTools) throttling, NOT Lantern simulation: mobile, CPU 4x,
  network ~100Mbps with ~0ms added latency. Bandwidth is intentionally wide so
  the diagnosis surfaces CPU cost, discovery/Load-Delay, and server response
  rather than "the pipe is slow".
- Because throttling is applied, the recorded trace IS the throttled experience:
  reported and observed FCP/LCP are EQUAL, so every window aggregation honestly
  reflects "what happened before FCP/LCP".
- Absolute numbers are lab values (somewhat pessimistic). Use them for STRUCTURAL
  comparison between sites, not as field (real-user) numbers.

## How to compare two sites
- Prefer phase-by-phase comparison (see the LCP 4 phases and phaseComposition):
  it is fair even when absolute LCP differs a lot (e.g. 2s vs 30s).
- Each analyzer result has: summary (top-line, for side-by-side), data (detail),
  findings (auto-generated observations), and a "basis" string stating exactly
  what is measured objectively vs heuristically.

## Validation
Trace parsing mirrors Lighthouse's own implementation and is cross-checked to
the millisecond against Lighthouse audits and Perfetto trace_processor.

See: \`analyze lcp --llm\`, \`analyze third-party --llm\`, \`analyze gtm --llm\`.`

const LLM_CAPTURE = `# capture — LLM guide

Runs Lighthouse (performance only) N times and keeps the MEDIAN run by LCP
(whole run kept, so trace and numbers stay consistent). Saves one directory:
meta.json, trace.json, devtoolslog.json, lhr.json.

## Throttling
Applied (DevTools): formFactor mobile, CPU 4x, download/upload ~100Mbps,
~0ms added latency. Rationale: keep a mobile CPU handicap but remove bandwidth
as a bottleneck, so structural problems (CPU, discovery, server latency) surface.
Recorded in meta.throttling.

## Chrome
Resolved at capture time: CHROME_PATH / installed Chrome first; otherwise
Chrome-for-Testing is downloaded via @puppeteer/browsers and cached under
~/.cache/performance-analyzer/browsers.

## Note on distribution
capture needs the JS runtime + dependencies (run via bun or node). It does NOT
work from a single compiled binary because Lighthouse loads runtime assets. The
analyze commands DO work as a standalone binary.`

const LLM_LCP = `# analyze lcp — LLM guide (what happens / obstructs / is slow before LCP)

## Windows
Aggregations use the observed trace clock (== reported under applied throttling).
Window [0, FCP] and [0, LCP].

## summary (top-line, for side-by-side)
- ttfbMs, fcpMs, lcpMs, tbtMs: headline metrics (ms). tbt is computed from the
  trace ([FCP, TTI]); may be undefined on very heavy pages.
- lcpRenderDelayMs: the Render Delay phase (often the key culprit).
- networkVerdict: latency-bound | bandwidth-bound | balanced (aggregate heuristic).
- deadTimeToLcpMs: time before LCP where NEITHER CPU nor network progressed.
- cpuRateToLcp: fraction of [0,LCP] the main thread was busy (0..1).
- lcpImagePrioritized: did the LCP image load with adequate priority (bool/n/a).
- lcpImageBottleneck: discovery | connection | waiting | download.
- lcpImageRank: "N/M images (#K overall)" — where the LCP image sits in load order.
- beforeLcpRequests / beforeLcpBytes: requests started / bytes before LCP.

## data.timeline
TTFB/FCP/LCP, DCL, load, TBT, blockingTimeToLcp, interactive, lcpMinusFcp (ms).

## data.lcp.phases — the 4-phase LCP decomposition (read this first)
TTFB → Load Delay (discovery) → Load Time (resource fetch) → Render Delay (paint).
Whichever dominates tells you the class of problem:
- Load Delay high → the LCP resource is discovered late (HTML/JS delays it; preload).
- Load Time high → the resource download itself is slow (size/bandwidth/contention).
- Render Delay high → resource is ready but paint is blocked (CPU or render-blocking).

## data.phaseComposition — CPU vs network-wait vs dead, per phase (FAIR comparison)
Each phase window split MECE into cpuMs (main thread busy) + networkWaitMs
(request in flight, CPU idle) + deadMs (neither). cpuMs+networkWaitMs+deadMs ==
windowMs. This is the fair axis to compare two sites even if phase lengths differ:
e.g. "Render Delay 28s = 14s CPU + 14s network-wait" vs the fast site's split.
data.compositionToLcp is the same split over all of [0, LCP]. Large deadMs means
artificial waits (timers, scheduling stalls, consent gates), not real work.

## data.mainThread.toFcp / toLcp
busyMs, idleMs, windowMs, and byCategory (scripting/parsing/rendering/painting/
gc/other) as self-time ms. High scripting → JS-bound; high idle → network-bound.

## data.longTasks
Top-level main-thread tasks > 50ms before LCP: count, totalMs, maxMs, top[] (with
attributable URL when resolvable).

## data.network.toFcp / toLcp
total (count/transferBytes/resourceBytes), byType, byPriority, thirdParty.
"resourceBytes" is decoded size; "transferBytes" is over the wire.

## data.latency
connectionSetupMs / waitingMs / downloadMs are SUMS over before-LCP requests
(a heuristic ratio under h2 multiplexing, NOT wall-clock). verdict from that ratio.
worstByWaiting / worstByDownload list the slowest individual requests.
rttByOrigin / serverLatencyByOrigin come from Lighthouse audits (per origin).

## data.htmlCss
HTML TTFB / transfer / decoded / download / complete time; CSS count / bytes /
when all render-blocking CSS finished (≈ earliest possible FCP).

## data.lcp.image
url, networkPriority, loadingAttr/isLazy, prioritizedWell (+ Lighthouse audit),
size{transferBytes, resourceBytes, displayW/H, intrinsicW/H, megapixels,
devicePixelRatio, oversizeFactor (>1.5 = larger than needed)},
network{requestStart/End, loadDelay, connectionSetup, dns/connect/tls, waiting,
download, bottleneck}. Read bottleneck to know whether to fix discovery (preload),
the image (format/size), the CDN (TTFB), or contention.

## data.crp — critical rendering path
- depth / longestPathMs / longestPathTransferBytes (from critical-request-chains).
- resources[]: each critical resource (document / render-blocking CSS+JS / LCP
  image) with its fetch decomposed: dns/connect/tls, connectionSetup, waiting
  (TTFB), download, transferBytes, newConnection, bottleneck. Spot a slow critical
  fetch (new-connection latency vs TTFB vs download/size). crpOrigins = distinct
  origins on the path (each new origin = a handshake).
- lcpImage{rankAmongImages, totalImages, rankOverall, imagesBeforeLcp}.
- obstructorsBeforeImageStart / obstructorsDuringImageLoad: NON-essential resources
  (not HTML/CSS/LCP image) that may delay discovery or steal bandwidth.

## findings
Auto-generated, causation-gated observations (e.g. discovery delay is only blamed
when Load Delay is actually large). Each has severity + message + evidence.

## Comparing fast vs slow
1) Compare the 4 phases — where does the slow site lose time?
2) Within the dominant phase, compare phaseComposition (CPU vs wait vs dead).
3) For image LCP, compare lcp.image.network bottleneck and size.
4) Check crp.resources for a slow critical fetch and crpOrigins for handshakes.`

const LLM_THIRD_PARTY = `# analyze third-party — LLM guide (tag volume, CPU, vendor breakdown)

## Definition (idea: "is our site over-tagged?")
- Tags = analytics / ads / pixels / A-B / chat / tag-managers / social + external
  web fonts (Google Fonts is INCLUDED).
- EXCLUDED: public CDN libraries (jsDelivr/cdnjs/unpkg/jQuery/Google CDN) — they
  are trivially self-hostable; shown separately as cdnLibraries for transparency.
- First party = the page's registrable domain (incl. subdomains).
Classification uses third-party-web + a CDN host list. CPU/blocking come from the
third-party-summary audit (per URL); bytes/counts from the network.

## summary
- tagRequests (request count) vs tagVendors (distinct entities) vs tagDomains:
  request count is inflated by chatty pixel-sync vendors; vendor count is the
  better "how many tags do we run" number.
- totalTransferKB / totalDecodedKB / totalCpuMs / totalTbtMs: WHOLE-PAGE totals.
- tpTransferShare / tpDecodedShare / tpCpuShare / tpTbtShare: third-party share of
  the whole page (%). NOTE: a low CPU share can still mean heavy third party if
  first-party JS is even heavier — always read absolute + share together.
- tpJsTransferKB / tpJsTransferShare / tpJsCpuShare: third-party JS only (images
  inflate byte share, so JS is the cleaner signal).
- tpLongTasks: long tasks attributed to third parties.
- heaviestVendorByCpu / heaviestVsAvg: the top vendor and its CPU vs the industry
  average (third-party-web averageExecutionTime). heaviestVsAvg > 1 means this
  site runs that vendor HEAVIER than typical (a "configured badly" signal).

## data
- share.{transfer,resource,cpu}: {total, thirdParty, thirdPartyJs, *Share}.
- blocking: totalTbtMs, thirdPartyTbtMs, thirdPartyTbtShare, thirdPartyLongTasks.
- redundancy: analyticsVendors[], tagManagerVendors[], gtmContainers[], ga4Ids[],
  notes[] (e.g. "2 analytics tools", "6 GTM containers", "2 GA4 ids").
- facades[]: heavy embeds that could be lazy-loaded (Lighthouse third-party-facades).
- renderBlocking[]: third-party resources that block rendering.
- byDomain / byEntity / byCategory: each {key, count, transferBytes, resourceBytes,
  cpuMs, blockingMs, beforeLcpCount, jsCpuMs, avgExecutionMs, cpuVsAvg}. Sorted by CPU.
  cpuVsAvg (entity rows) = this site's CPU for that vendor ÷ its industry average.
- heaviestByCpu / heaviestByTransfer: top entities.
- tagRequests[] / cdnLibraryRequests[]: per-request detail (the excluded CDN libs
  are listed separately).

## How to read / compare
- "Why so many tags / whose fault?" → byEntity / heaviestByCpu (and cpuVsAvg for
  "we use vendor X N× heavier than typical").
- Page burden → tpCpuShare / tpJsCpuShare and absolute totalCpuMs.
- Hygiene → redundancy (duplicate analytics, multiple GTM/GA ids), renderBlocking.
- Compare two sites on: vendor count, JS CPU/transfer share, heaviest vendors,
  and cpuVsAvg per shared vendor.`

const LLM_GTM = `# analyze gtm — LLM guide (objective overview of GTM bloat)

Container bodies are not in the trace: container ids are detected from the network
and each gtm.js is FETCHED LIVE and parsed with an AST (literal evaluation; JSON
fallback). Answers "why is GTM so big / what is it used for", objectively.

## summary
- containers, tags, variables.
- firingTags / controlTags / pausedTags: MECE class of every tag (see tagClass).
- customHtml: number of Custom HTML tags (arbitrary JS).
- legacyUa: Universal Analytics tags (measurement stopped — likely dead weight).
- pausedTags: paused in the UI but still shipped in the container (dead weight).
- firesOnPageview: tags that fire on every page (always-on cost).
- transferKB / cpuMs: GTM-served scripts only (gtm.js/gtag). NOTE: the cost of
  vendors that GTM INJECTS appears under those vendors, so GTM's true footprint is
  larger and distributed — see the third-party analyzer.
- topVendor / topVendorTags: the vendor the most tags are for (the headline answer).
- topTagType: the most common tag type.

## data
- containers[]: per container {id, fetched, parser, version, transferBytes, tags,
  variables, predicates, rules, customHtml, legacyUa, pausedTags, tagClass,
  tagsByType, tagsByVendor, firing, firesOnPageview}.
- totals: the same aggregated, incl. tagClass {firing, control, paused}.
- tagClass (MECE, sums to total tags):
    firing  = real tags that do work (measurement, pixels, ads, Custom HTML)
    control = auto-event listeners / Zone (infrastructure, send no data)
    paused  = paused but shipped (dead weight)
  Reframes "421 tags" as e.g. "354 firing + 46 control + 21 paused".
- tagsByType[]: {type, label, count, deprecated} — e.g. Custom HTML, GA4 Event,
  Universal Analytics (deprecated), Custom Template, Paused.
- tagsByVendor[]: {key, count} — tags attributed to each third-party vendor by
  config domain / unambiguous template type. THE answer to "what is GTM used for".
  A tag can map to several vendors; "(未帰属)/unattributed" = listeners, custom
  templates, or custom HTML without a recognizable domain.
- gtagIds: ga4 / ads / floodlight / universalAnalytics / other measurement ids.
- firing: tags by lifecycle event {pageview, domReady, windowLoad, interaction,
  custom, unknown}.

## Objective vs heuristic (stated in data.basis)
OBJECTIVE: all counts (containers, tags, variables, function-type breakdown,
custom HTML / UA / paused). HEURISTIC: firing timing (from positive \`if\`
triggers; blocking/exception triggers not modeled), vendor attribution (config
domain references, not confirmed loads), and CPU/transfer (GTM-served scripts only).

## How to read / "where to diet"
- Headline: "GTM heavy — what's the cause?" → topVendor + tagsByVendor.
- Dead weight to delete first: pausedTags, legacyUa.
- Risk/heaviness: customHtml count, firesOnPageview.
- Cross-link to third-party for the actual CPU/bytes those tags cause at runtime.`

const LLM_TOPICS: Record<string, string> = {
  overview: LLM_OVERVIEW,
  capture: LLM_CAPTURE,
  lcp: LLM_LCP,
  'third-party': LLM_THIRD_PARTY,
  gtm: LLM_GTM,
}

/** Long LLM-oriented help for a topic; 'all' concatenates everything. */
export function llmHelp(topic: string): string {
  if (topic === 'all') {
    return [LLM_OVERVIEW, LLM_CAPTURE, LLM_LCP, LLM_THIRD_PARTY, LLM_GTM].join('\n\n' + '─'.repeat(72) + '\n\n')
  }
  return LLM_TOPICS[topic] ?? LLM_OVERVIEW
}

export function hasLlmTopic(topic: string): boolean {
  return topic in LLM_TOPICS
}
