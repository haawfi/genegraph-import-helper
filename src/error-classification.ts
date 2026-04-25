import type { AxiosError } from "axios"

/**
 * error-classification.ts — DH2 §4
 *
 * Classifies an upload error into one of four categories so the
 * helper's retry logic + UX can react appropriately.
 *
 * Why classify:
 *   Pre-DH2 every chunk failure used the same 3-attempt retry
 *   policy. That's wasteful for permanent client errors (a 413
 *   "payload too large" will never succeed on retry; a 401
 *   "session expired" needs the user to re-login, not three
 *   more chunk POSTs). Classification lets us:
 *     - retry the things that benefit from retry (network
 *       flakes, server hiccups)
 *     - surface a re-login affordance for auth failures
 *     - mark the upload permanently failed for client errors
 *       and stop wasting cycles
 *
 * Categories:
 *   - "transient"     — network error (no HTTP response). Retry.
 *   - "retry"         — server-side 5xx. Retry.
 *   - "auth-fail"     — 401. Stop retrying; route to login.
 *   - "permanent-fail" — 410, 413, 422, or other 4xx that won't
 *                        change on retry. Mark failed; surface
 *                        a specific error message.
 *
 * The function is pure — input axios error in, classification
 * out. No side effects, no logging. Consumers (chunked-uploader
 * + main.ts) decide what to do with the verdict.
 */

export type UploadErrorCategory =
  | "transient"
  | "retry"
  | "auth-fail"
  | "permanent-fail"

/**
 * Classify an axios error from a chunk POST or session-create
 * call. Defaults to "transient" for anything we can't pattern-
 * match (the retry path is the safe default — it won't waste
 * the budget on the post-wake exemption path, but it WILL surface
 * a real failure if the error keeps recurring).
 */
export function classifyError(
  err: unknown,
): UploadErrorCategory {
  // Pure network error (DNS fail, connection reset, timeout
  // before any HTTP response). The actual axios error has no
  // `.response` field in this case.
  const axiosErr = err as AxiosError | undefined
  const status = axiosErr?.response?.status
  if (typeof status !== "number") return "transient"

  if (status === 401) return "auth-fail"
  if (status === 410 || status === 413 || status === 422) {
    return "permanent-fail"
  }
  if (status >= 500) return "retry"
  if (status >= 400) return "permanent-fail"
  return "retry"
}

/**
 * Human-readable copy for each permanent-fail status. The helper
 * surfaces this directly in a notification on permanent-fail
 * branches so the user knows what to do next.
 */
export function permanentFailMessage(status: number | undefined): string {
  switch (status) {
    case 410:
      return "This upload session expired. Please re-detect the archive and try again."
    case 413:
      return "This file is too large for the current upload limits."
    case 422:
      return "The server rejected this archive (invalid format)."
    case 403:
      return "This device is no longer registered. Please sign in again from the helper."
    default:
      return `The server rejected this upload (HTTP ${status ?? "unknown"}).`
  }
}
