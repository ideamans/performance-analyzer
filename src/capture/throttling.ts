/**
 * Throttling applied during capture (with throttlingMethod: 'devtools', so the
 * recorded trace reflects these conditions directly).
 *
 * Intent: keep a mobile CPU handicap (4x) but make the network effectively
 * unthrottled (~100 Mbps, near-zero added latency). This removes bandwidth as a
 * bottleneck so the diagnosis surfaces CPU cost, discovery/Load-Delay, and
 * server response time rather than "the pipe is slow".
 */
const MBPS_100_KBPS = 100 * 1000 // 100 Mbps in Kbps

export const THROTTLING = {
  // Used by Lantern ('simulate'); kept consistent for completeness.
  rttMs: 0,
  throughputKbps: MBPS_100_KBPS,
  // Used by applied ('devtools') throttling — what actually takes effect here.
  requestLatencyMs: 0,
  downloadThroughputKbps: MBPS_100_KBPS,
  uploadThroughputKbps: MBPS_100_KBPS,
  cpuSlowdownMultiplier: 4,
} as const

/** Human-readable summary, recorded in meta and surfaced in reports. */
export const THROTTLING_DESCRIPTION =
  'mobile, CPU 4x, network ~100Mbps down/up, ~0ms added latency (bandwidth intentionally not a bottleneck)'
