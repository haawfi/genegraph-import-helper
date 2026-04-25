/**
 * wake-clock.ts — DH2 §3
 *
 * Tracks the timestamp of the most recent OS wake event so other
 * modules (currently `chunked-uploader.ts`) can decide whether a
 * fresh failure should count against the retry budget.
 *
 * Why this exists:
 *   Pre-DH2 the chunked uploader treated every chunk POST failure
 *   the same way — three retries with exponential backoff, then
 *   give up. That's correct for transient network flakes. It's
 *   wrong for the path where the user closed their laptop for
 *   four hours mid-upload and the network is still re-establishing
 *   itself. Failures in that window are expected; counting them
 *   against the budget would burn it on conditions that resolve
 *   themselves within seconds.
 *
 * The module is intentionally tiny — one timestamp + one boolean
 * helper. The powerMonitor wiring lives in main.ts; the consumer
 * (`chunked-uploader.ts`) just imports `isInPostWakeWindow` and
 * checks it in the retry catch block.
 *
 * Cap rationale:
 *   30 seconds after wake, normal retry budget applies. The spec
 *   explicitly caps the exemption ("after that, normal retry
 *   budget applies") to prevent a "retries forever after wake
 *   when the server is genuinely down" failure mode.
 */

const POST_WAKE_TOLERANCE_MS = 30_000

let lastWakeAt: number | null = null

/**
 * Called by the powerMonitor.resume handler in main.ts. Records
 * the wake timestamp; subsequent calls within
 * POST_WAKE_TOLERANCE_MS will see `isInPostWakeWindow()` return
 * true.
 */
export function markWakeNow(): void {
  lastWakeAt = Date.now()
}

/**
 * Test helper. Resets the wake clock so individual tests don't
 * leak state into one another.
 */
export function resetWakeClock(): void {
  lastWakeAt = null
}

/**
 * Returns true when the helper is within the post-wake tolerance
 * window. Consumers (currently `chunked-uploader.ts`) check this
 * in their retry catch block: when true, log + retry without
 * decrementing the budget.
 */
export function isInPostWakeWindow(now: number = Date.now()): boolean {
  if (lastWakeAt === null) return false
  return now - lastWakeAt < POST_WAKE_TOLERANCE_MS
}

/** Exposed for diagnostics + tests. */
export function getLastWakeAt(): number | null {
  return lastWakeAt
}

/** Exposed for diagnostics + tests. */
export const POST_WAKE_TOLERANCE_MS_CONST = POST_WAKE_TOLERANCE_MS
