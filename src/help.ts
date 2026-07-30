/**
 * Help text. Short `--help` is context-aware; long `--llm` emits detailed,
 * LLM-oriented docs including how to read the output data. All in English.
 *
 * Main theme: what third-party tags cost this page. `gtm` explains where those
 * tags come from; `lcp` is the bonus angle that isolates NON-third-party causes.
 */

export const SHORT_HELP = `third-party-analyzer — measure how much third-party tags cost a page, and what to cut.

Capture a Lighthouse trace once, then analyze it: tag weight (main), the GTM
container behind the tags, and — as a bonus — the non-third-party LCP causes.

USAGE
  third-party-analyzer <command> [options]

COMMANDS
  capture <url> --out <dir>     Measure a URL and save raw artifacts
  analyze <angle> <runDir>      Analyze saved artifacts from one angle

ANGLES (for analyze)
  third-party   MAIN: tag count / bytes / CPU / TBT, per vendor, vs industry avg
  gtm           Where the tags come from: GTM container makeup (fetches gtm.js)
  lcp           BONUS: LCP causes that are NOT third-party (TTFB, discovery, image)

TYPICAL USES
  - Benchmark an industry (e.g. 10 fashion e-commerce sites) on tag weight
  - Build a "tag diet" report for one site: what to delete, defer, or reconfigure

GLOBAL
  -h, --help    Show help. Context-aware: \`<command> --help\`
  --llm         Long, LLM-oriented help incl. how to read the output.
                Per command/angle, e.g. \`analyze third-party --llm\`. Bare \`--llm\` = everything.

EXAMPLES
  third-party-analyzer capture https://example.com --out ./runs/site --device mobile --runs 3
  third-party-analyzer analyze third-party ./runs/site --stdout
  third-party-analyzer analyze gtm         ./runs/site --stdout
  third-party-analyzer analyze lcp         ./runs/site --format json --out ./reports

See \`third-party-analyzer <command> --help\` for options,
or \`third-party-analyzer <command|angle> --llm\` for full docs + data interpretation.`

export const CAPTURE_HELP = `capture — measure a URL with Lighthouse (performance category only) and save raw artifacts.

USAGE
  third-party-analyzer capture <url> --out <dir> [options]

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
  - Wide bandwidth is deliberate: it stops "the pipe is slow" from masking the CPU
    cost of tags, which is what this tool is about.
  - Chrome is auto-detected, or auto-downloaded (Chrome-for-Testing) if missing.
  - For a multi-site benchmark, capture every site with the SAME device/runs, e.g.
    one directory per site under ./runs/<site>.`

export const ANALYZE_HELP = `analyze — analyze saved artifacts from one angle.

USAGE
  third-party-analyzer analyze <angle> <runDir> [options]

ANGLES
  third-party   MAIN: what the tags cost (bytes / CPU / TBT / per vendor / vs avg)
  gtm           Where the tags come from (GTM container makeup; fetches gtm.js live)
  lcp           BONUS: non-third-party LCP causes (TTFB, discovery, image, CRP)

OPTIONS
  --format <list>   Comma-separated reporters: json    (default: json)
  --out <dir>       Where to write report files        (default: <runDir>)
  --stdout          Print to stdout instead of writing files
  -h, --help        Show this help        |  --llm  Full docs + how to read data

For the meaning of every output field, run:
  third-party-analyzer analyze <angle> --llm`

const LLM_OVERVIEW = `# third-party-analyzer — LLM guide

## Purpose
Quantify **what third-party tags cost a page**, and turn that into a decision:
which tags to delete, defer, or reconfigure. Tag analysis is the main theme; the
GTM angle explains where the tags come from; the LCP angle is a BONUS that
isolates the causes that are NOT third-party, so a report does not blame tags for
a problem they did not cause.

Two intended uses:
1) **Industry benchmark** — capture N sites in the same sector (e.g. 10 fashion
   e-commerce sites) and rank/compare their tag weight. Answers "is our tag load
   normal for this industry, or are we the outlier?"
2) **Tag diet report for one site** — capture one site and produce a concrete
   "delete / defer / reconfigure" list with the ms and KB attached to each item.

Also usable for research (surveying tag practice across many sites).

## Angles, in the order you should read them
1) \`third-party\` — the main answer: how many tags, whose, how many bytes/ms/TBT,
   and how that compares to the industry average per vendor.
2) \`gtm\` — the supply side: how the GTM container is built up (tag count by
   vendor / type, paused and legacy dead weight). This is where a diet is
   actually executed, so it turns "too heavy" into "delete these".
3) \`lcp\` — the bonus: if LCP is bad for reasons other than tags (slow TTFB, late
   image discovery, oversized LCP image, render-blocking first-party CSS/JS), say
   so. Prevents an over-attribution of blame to third parties.

## Model: capture once, analyze from many angles
1) capture: run Lighthouse ONCE per site, save raw artifacts (trace, devtoolslog,
   lhr, meta).
2) analyze: run pure analyzers over the SAME artifacts (third-party, gtm, lcp).
Re-analyze freely without re-measuring. There is no automatic \`compare\` command
by design — you produce one report per site and compare them (an LLM is well
suited to this).

## Measurement conditions (important for fair comparison)
- APPLIED (DevTools) throttling, NOT Lantern simulation: mobile, CPU 4x,
  network ~100Mbps with ~0ms added latency. Bandwidth is intentionally wide so
  that tag CPU cost, discovery/Load-Delay and server response surface instead of
  "the pipe is slow".
- Because throttling is applied, the recorded trace IS the throttled experience:
  reported and observed FCP/LCP are EQUAL, so every window aggregation honestly
  reflects "what happened before FCP/LCP".
- Absolute numbers are lab values (somewhat pessimistic). Use them for STRUCTURAL
  comparison between sites, not as field (real-user) numbers.
- Tags load conditionally (consent gates, A/B, geo, session). One capture is one
  sample of a variable population — say so in a report, and re-capture if a
  number looks implausible.

## How to run a multi-site benchmark
- Capture every site with identical \`--device\` and \`--runs\` (defaults are fine),
  one directory per site.
- Run \`analyze third-party\` (and \`gtm\`) for each, then compare on:
  tagVendors (distinct entities), tpJsTransferKB, totalCpuMs / tpCpuShare,
  tpJsCpuShare, tpTbtMs, heaviestVendorByCpu, and cpuVsAvg for vendors that
  several sites share.
- Prefer **vendor count + third-party JS CPU** as the headline comparison, not raw
  request count (chatty pixel-sync vendors inflate it) and not total bytes
  (images inflate it).
- Also record which vendors are unique to which site — the cheapest diet is often
  "this competitor does the same job with fewer vendors".

## How to write a tag diet report
Order the recommendations by (confidence x saving), and attach evidence to each:
1) **Delete — dead weight, no functional loss**: GTM \`pausedTags\`,
   \`legacyUa\` (Universal Analytics, measurement stopped), duplicate analytics /
   multiple GTM containers / multiple GA4 ids (\`data.redundancy\`).
2) **Delete or consolidate — redundant function**: two vendors doing the same job
   (two heatmap tools, two A/B tools) from \`byEntity\` / \`byCategory\`.
3) **Defer** — \`facades[]\` (chat, video, social embeds that can be lazy-loaded)
   and third-party \`renderBlocking[]\` entries (make them async/defer).
4) **Reconfigure, not remove** — vendors whose \`cpuVsAvg\` is well above 1: the
   same tag runs heavier here than typical, which is usually configuration
   (recording rate, too many custom events, Custom HTML wrapping).
5) **Keep** — name what should NOT be cut (core measurement), so the report reads
   as an engineering plan rather than an anti-tag campaign.
Then cross-check with \`lcp\`: if tags are not on the critical path and LCP is lost
to TTFB or image discovery, the report must say the diet improves TBT/CPU rather
than promising an LCP win.

## Validation
Trace parsing mirrors Lighthouse's own implementation and is cross-checked to the
millisecond against Lighthouse audits and Perfetto trace_processor.

See: \`analyze third-party --llm\`, \`analyze gtm --llm\`, \`analyze lcp --llm\`.`

const LLM_CAPTURE = `# capture — LLM guide

Runs Lighthouse (performance only) N times and keeps the MEDIAN run by LCP
(whole run kept, so trace and numbers stay consistent). Saves one directory:
meta.json, trace.json, devtoolslog.json, lhr.json.

## Throttling
Applied (DevTools): formFactor mobile, CPU 4x, download/upload ~100Mbps,
~0ms added latency. Rationale: keep a mobile CPU handicap but remove bandwidth
as a bottleneck, so the CPU cost of tags (and discovery / server latency)
surfaces instead of being hidden behind a slow pipe. Recorded in meta.throttling.

## Capturing a benchmark set
Use the same device and runs for every site, one directory per site
(./runs/<site>). Tag payloads vary by consent state, geography and A/B bucket, so
a single capture is one sample; re-capture when a number looks off.

## Chrome
Resolved at capture time: CHROME_PATH / installed Chrome first; otherwise
Chrome-for-Testing is downloaded via @puppeteer/browsers and cached under
~/.cache/third-party-analyzer/browsers.

## Note on distribution
capture needs the JS runtime + dependencies (run via bun or node). It does NOT
work from a single compiled binary because Lighthouse loads runtime assets. The
analyze commands DO work as a standalone binary.`

const LLM_THIRD_PARTY = `# analyze third-party — LLM guide (THE MAIN ANGLE: what the tags cost)

## Definition
- Tags = analytics / ads / pixels / A-B / chat / tag-managers / social + external
  web fonts (Google Fonts is INCLUDED).
- EXCLUDED: public CDN libraries (jsDelivr/cdnjs/unpkg/jQuery/Google CDN) — they
  are trivially self-hostable, so they are not a "tag" decision; shown separately
  as cdnLibraries for transparency.
- First party = the page's registrable domain (incl. subdomains).
Classification uses third-party-web + a CDN host list. CPU/blocking come from the
third-party-summary audit (per URL); bytes/counts from the network.

## summary
- tagRequests (request count) vs tagVendors (distinct entities) vs tagDomains:
  request count is inflated by chatty pixel-sync vendors; **vendor count is the
  better "how many tags do we run" number** and the better cross-site comparator.
- totalTransferKB / totalDecodedKB / totalCpuMs / totalTbtMs: WHOLE-PAGE totals.
- tpTransferShare / tpDecodedShare / tpCpuShare / tpTbtShare: third-party share of
  the whole page (%). NOTE: a low CPU share can still mean heavy third party if
  first-party JS is even heavier — always read absolute + share together.
- tpJsTransferKB / tpJsTransferShare / tpJsCpuShare: third-party JS only (images
  inflate byte share, so JS is the cleaner signal for tag weight).
- tpLongTasks: long tasks attributed to third parties.
- heaviestVendorByCpu / heaviestVsAvg: the top vendor and its CPU vs the industry
  average (third-party-web averageExecutionTime). heaviestVsAvg > 1 means this
  site runs that vendor HEAVIER than typical — a "configured badly" signal, i.e. a
  reconfigure candidate rather than a delete candidate.

## data
- share.{transfer,resource,cpu}: {total, thirdParty, thirdPartyJs, *Share}.
- blocking: totalTbtMs, thirdPartyTbtMs, thirdPartyTbtShare, thirdPartyLongTasks.
  This is where tags usually hurt most (responsiveness), more than LCP.
- redundancy: analyticsVendors[], tagManagerVendors[], gtmContainers[], ga4Ids[],
  notes[] (e.g. "2 analytics tools", "6 GTM containers", "2 GA4 ids").
  → the highest-confidence diet items: duplication with no functional gain.
- facades[]: heavy embeds that could be lazy-loaded (Lighthouse third-party-facades)
  → the "defer" bucket.
- renderBlocking[]: third-party resources that block rendering → fix or defer.
- byDomain / byEntity / byCategory: each {key, count, transferBytes, resourceBytes,
  cpuMs, blockingMs, beforeLcpCount, jsCpuMs, avgExecutionMs, cpuVsAvg}. Sorted by CPU.
  cpuVsAvg (entity rows) = this site's CPU for that vendor / its industry average.
  byCategory answers "do we run two tools for the same job?".
  beforeLcpCount tells you whether that vendor is even on the LCP path.
- heaviestByCpu / heaviestByTransfer: top entities — the diet's first targets.
- tagRequests[] / cdnLibraryRequests[]: per-request detail (the excluded CDN libs
  are listed separately).

## How to read
- "How many tags, and whose fault is the weight?" → tagVendors, byEntity,
  heaviestByCpu.
- "Delete, defer, or reconfigure?" → redundancy + byCategory (delete),
  facades + renderBlocking (defer), cpuVsAvg > 1 (reconfigure).
- Page burden → tpCpuShare / tpJsCpuShare with absolute totalCpuMs and tpTbtMs.
- "Will a diet improve LCP?" → beforeLcpCount per vendor and renderBlocking; if
  tags mostly land after LCP, promise TBT/CPU/interactivity gains, not LCP.

## Comparing sites (benchmark)
Compare on: tagVendors, tpJsTransferKB, tpJsCpuShare, tpTbtMs,
heaviestVendorByCpu, and cpuVsAvg for vendors both sites run. Two sites with the
same vendor list can differ several-fold on CPU — that difference is
configuration, and it is the most actionable finding you can report.`

const LLM_GTM = `# analyze gtm — LLM guide (where the tags come from: container makeup)

Container bodies are not in the trace: container ids are detected from the network
and each gtm.js is FETCHED LIVE and parsed with an AST (literal evaluation; JSON
fallback). Answers "why is GTM so big / what is it used for", objectively — and
gives you the list you actually edit when executing a tag diet.

## summary
- containers, tags, variables.
- firingTags / controlTags / pausedTags: MECE class of every tag (see tagClass).
- customHtml: number of Custom HTML tags (arbitrary JS).
- legacyUa: Universal Analytics tags (measurement stopped — likely dead weight).
- pausedTags: paused in the UI but still shipped in the container (dead weight).
- firesOnPageview: tags that fire on every page (always-on cost).
- transferKB / cpuMs: GTM-served scripts only (gtm.js/gtag). NOTE: the cost of
  vendors that GTM INJECTS appears under those vendors, so GTM's true footprint is
  larger and distributed — read this together with the third-party angle.
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
  Reframes "421 tags" as e.g. "354 firing + 46 control + 21 paused" — do this
  before claiming a container is bloated.
- tagsByType[]: {type, label, count, deprecated} — e.g. Custom HTML, GA4 Event,
  Universal Analytics (deprecated), Custom Template, Paused.
- tagsByVendor[]: {key, count} — tags attributed to each third-party vendor by
  config domain / unambiguous template type. THE answer to "what is GTM used for".
  A tag can map to several vendors; the key "(未帰属)" (unattributed) = listeners, custom
  templates, or custom HTML without a recognizable domain.
- gtagIds: ga4 / ads / floodlight / universalAnalytics / other measurement ids.
- firing: tags by lifecycle event {pageview, domReady, windowLoad, interaction,
  custom, unknown}.

## Objective vs heuristic (stated in data.basis)
OBJECTIVE: all counts (containers, tags, variables, function-type breakdown,
custom HTML / UA / paused). HEURISTIC: firing timing (from positive \`if\`
triggers; blocking/exception triggers not modeled), vendor attribution (config
domain references, not confirmed loads), and CPU/transfer (GTM-served scripts only).

## How to read / where to diet
- Delete first, zero risk: pausedTags, legacyUa.
- Then: duplicate vendors in tagsByVendor, and Custom HTML that duplicates a
  native template (customHtml count is also a risk/maintenance signal).
- Always-on cost: firesOnPageview — move what can wait to interaction triggers.
- Cross-link to third-party for the actual CPU/bytes those tags cause at runtime:
  GTM tells you WHAT is installed, third-party tells you WHAT IT COSTS.
- A container fetched now may differ from the container captured earlier
  (\`fetched\`, \`version\`) — note that when the two angles disagree.`

const LLM_LCP = `# analyze lcp — LLM guide (BONUS: the LCP causes that are NOT third-party)

This is the secondary angle. Its job in a report is to keep the tag analysis
honest: it shows how much of LCP is lost to first-party/infrastructure causes
(TTFB, late image discovery, oversized image, render-blocking CSS/JS) so a tag
diet is not sold as a fix for something it cannot fix. Third-party weight itself
is quantified by the third-party angle.

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
TTFB -> Load Delay (discovery) -> Load Time (resource fetch) -> Render Delay (paint).
Whichever dominates tells you the class of problem:
- Load Delay high → the LCP resource is discovered late (HTML/JS delays it; preload).
- Load Time high → the resource download itself is slow (size/bandwidth/contention).
- Render Delay high → resource is ready but paint is blocked (CPU or render-blocking).
Only the CPU-flavoured cases can be blamed on tags — and only if third-party work
actually lands in that window (check third-party beforeLcpCount / renderBlocking).

## data.phaseComposition — CPU vs network-wait vs dead, per phase (FAIR comparison)
Each phase window split MECE into cpuMs (main thread busy) + networkWaitMs
(request in flight, CPU idle) + deadMs (neither). cpuMs+networkWaitMs+deadMs ==
windowMs. This is the fair axis to compare two sites even if phase lengths differ:
e.g. "Render Delay 28s = 14s CPU + 14s network-wait" vs the fast site's split.
data.compositionToLcp is the same split over all of [0, LCP]. Large deadMs means
artificial waits (timers, scheduling stalls, consent gates), not real work —
consent gates are a third-party-shaped cause, so check the tag report for one.

## data.mainThread.toFcp / toLcp
busyMs, idleMs, windowMs, and byCategory (scripting/parsing/rendering/painting/
gc/other) as self-time ms. High scripting → JS-bound; high idle → network-bound.

## data.longTasks
Top-level main-thread tasks > 50ms before LCP: count, totalMs, maxMs, top[] (with
attributable URL when resolvable). Compare with the third-party angle's
tpLongTasks to split first-party from tag-caused stalls.

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
when all render-blocking CSS finished (~= earliest possible FCP).

## data.lcp.image
url, networkPriority, loadingAttr/isLazy, prioritizedWell (+ Lighthouse audit),
size{transferBytes, resourceBytes, displayW/H, intrinsicW/H, megapixels,
devicePixelRatio, oversizeFactor (>1.5 = larger than needed)},
network{requestStart/End, loadDelay, connectionSetup, dns/connect/tls, waiting,
download, bottleneck}. Read bottleneck to know whether to fix discovery (preload),
the image (format/size), the CDN (TTFB), or contention. None of these are tag
problems — they belong in the "besides the diet" section of a report.

## data.crp — critical rendering path
- depth / longestPathMs / longestPathTransferBytes (from critical-request-chains).
- resources[]: each critical resource (document / render-blocking CSS+JS / LCP
  image) with its fetch decomposed: dns/connect/tls, connectionSetup, waiting
  (TTFB), download, transferBytes, newConnection, bottleneck. Spot a slow critical
  fetch (new-connection latency vs TTFB vs download/size). crpOrigins = distinct
  origins on the path (each new origin = a handshake) — third-party origins here
  are a tag problem worth escalating.
- lcpImage{rankAmongImages, totalImages, rankOverall, imagesBeforeLcp}.
- obstructorsBeforeImageStart / obstructorsDuringImageLoad: NON-essential resources
  (not HTML/CSS/LCP image) that may delay discovery or steal bandwidth. Tag scripts
  showing up here is the strongest "tags hurt LCP" evidence this tool produces.

## findings
Auto-generated, causation-gated observations (e.g. discovery delay is only blamed
when Load Delay is actually large). Each has severity + message + evidence.

## How to use it alongside the tag report
1) Compare the 4 phases — where does the slow site lose time?
2) Within the dominant phase, compare phaseComposition (CPU vs wait vs dead).
3) Decide attribution: tags can only explain CPU in the window, render-blocking
   third parties, consent-gate dead time, and obstructors during image load.
4) Everything else (TTFB, image size, first-party CSS/JS) goes in the report as
   "work that a tag diet will not fix".`

const LLM_TOPICS: Record<string, string> = {
  overview: LLM_OVERVIEW,
  capture: LLM_CAPTURE,
  'third-party': LLM_THIRD_PARTY,
  gtm: LLM_GTM,
  lcp: LLM_LCP,
}

/** Long LLM-oriented help for a topic; 'all' concatenates everything. */
export function llmHelp(topic: string): string {
  if (topic === 'all') {
    return [LLM_OVERVIEW, LLM_CAPTURE, LLM_THIRD_PARTY, LLM_GTM, LLM_LCP].join('\n\n' + '─'.repeat(72) + '\n\n')
  }
  return LLM_TOPICS[topic] ?? LLM_OVERVIEW
}

export function hasLlmTopic(topic: string): boolean {
  return topic in LLM_TOPICS
}
