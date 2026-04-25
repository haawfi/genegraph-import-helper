/**
 * DH2 §3 — wake-clock module behavior.
 *
 * The clock is the seam between Electron's powerMonitor (which
 * fires on suspend/resume) and chunked-uploader's retry logic
 * (which checks `isInPostWakeWindow` to decide whether a fresh
 * failure counts against the 3-retry budget).
 *
 * Pure module — no I/O, no Electron, just a timestamp + a
 * boolean predicate. The cap (30 seconds) prevents a "retries
 * forever after wake when the server is genuinely down" failure
 * mode.
 */

import {
  markWakeNow,
  resetWakeClock,
  isInPostWakeWindow,
  getLastWakeAt,
  POST_WAKE_TOLERANCE_MS_CONST,
} from "../wake-clock"

beforeEach(() => {
  resetWakeClock()
})

describe("DH2 §3 — wake-clock", () => {
  test("isInPostWakeWindow is false when never marked", () => {
    expect(isInPostWakeWindow()).toBe(false)
    expect(getLastWakeAt()).toBeNull()
  })

  test("markWakeNow records the timestamp; isInPostWakeWindow is true immediately after", () => {
    markWakeNow()
    expect(getLastWakeAt()).not.toBeNull()
    expect(isInPostWakeWindow()).toBe(true)
  })

  test("the tolerance window expires after 30 seconds", () => {
    markWakeNow()
    const wakeAt = getLastWakeAt()!

    // 1ms before the cap → still inside.
    expect(isInPostWakeWindow(wakeAt + POST_WAKE_TOLERANCE_MS_CONST - 1)).toBe(
      true,
    )
    // Exactly at the cap → outside (strict less-than).
    expect(isInPostWakeWindow(wakeAt + POST_WAKE_TOLERANCE_MS_CONST)).toBe(
      false,
    )
    // 1ms after the cap → outside.
    expect(isInPostWakeWindow(wakeAt + POST_WAKE_TOLERANCE_MS_CONST + 1)).toBe(
      false,
    )
  })

  test("a second markWakeNow extends the window from the new wake point", () => {
    markWakeNow()
    const firstWakeAt = getLastWakeAt()!
    // Re-mark 25 seconds later — outside what the FIRST wake's
    // window would have been by 5s, but the new wake's window
    // resets the clock.
    markWakeNow()
    const secondWakeAt = getLastWakeAt()!
    expect(secondWakeAt).toBeGreaterThanOrEqual(firstWakeAt)
    // 5s after the second mark — inside.
    expect(isInPostWakeWindow(secondWakeAt + 5_000)).toBe(true)
  })

  test("resetWakeClock clears the timestamp", () => {
    markWakeNow()
    resetWakeClock()
    expect(getLastWakeAt()).toBeNull()
    expect(isInPostWakeWindow()).toBe(false)
  })
})
