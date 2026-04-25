import axios from "axios"
import type { UploadStateStore, ActiveUpload } from "./upload-state-store"

/**
 * startup-reconciler.ts — DH2 §2
 *
 * On helper startup, every entry in the UploadStateStore is in
 * an indeterminate state — the helper might have crashed mid-
 * upload, or the OS slept long enough that the server completed
 * the import on the bytes it had, or the session was cleaned up
 * by the server's stale-session sweep. This module asks the
 * server for canonical state and decides what to do with each
 * local entry.
 *
 * Three outcomes per entry, mirroring the DH2 §2 spec:
 *   - Server says COMPLETED:
 *       Local store is cleared. UI surfaces "Upload completed
 *       in your absence" via the caller's notification adapter.
 *   - Server says UPLOADING / WAITING_PARTS / DETECTING /
 *     PENDING:
 *       Local entry is updated to reflect the server's
 *       lastConfirmedChunk pointer; the caller decides whether
 *       to surface a "Resume upload" banner or auto-resume.
 *       (Spec rule: never auto-resume without user confirmation.)
 *   - Server returns 404 (session expired / cleaned up) or
 *     server is unreachable:
 *       Local entry is cleared (404) or left as-is (unreachable
 *       — try again on next reconcile cycle). Caller is told.
 *
 * The reconciler is pure logic — it doesn't touch UI surfaces.
 * The caller (main.ts) orchestrates banners + tray updates.
 */

export type ReconcileOutcome =
  | { kind: "completed"; sessionId: string; entry: ActiveUpload }
  | {
      kind: "resumable"
      sessionId: string
      entry: ActiveUpload
      partsReceived: number
      receivedChunks: number[]
    }
  | { kind: "expired"; sessionId: string; entry: ActiveUpload }
  | { kind: "unreachable"; sessionId: string; entry: ActiveUpload; error: string }

export interface ReconcileDeps {
  apiBaseUrl: string
  authToken: string
  store: UploadStateStore
  /** Override for tests; in production this defaults to axios. */
  http?: {
    get: (
      url: string,
      config: { params: Record<string, unknown>; headers: Record<string, string>; timeout: number },
    ) => Promise<{ status: number; data: unknown }>
  }
}

interface ChunkProbeResponse {
  sessionId: string
  uploadStatus: "DETECTING" | "WAITING_PARTS" | "UPLOADING" | "COMPLETED" | "FAILED"
  partsExpected: number
  partsReceived: number
  receivedChunks: number[]
  uploadedBytes: number
  totalBytes: number | null
}

const TERMINAL_COMPLETED = new Set(["COMPLETED"])
const TERMINAL_GONE = new Set(["FAILED"])

/**
 * Reconcile every entry in the store. Returns one outcome per
 * entry. Does NOT mutate the UI; the caller renders.
 *
 * The store is mutated where applicable (completed → removed;
 * resumable → lastConfirmedChunk updated to the server's view;
 * expired → removed; unreachable → left as-is for the next pass).
 */
export async function reconcileOnStartup(
  deps: ReconcileDeps,
): Promise<ReconcileOutcome[]> {
  const outcomes: ReconcileOutcome[] = []
  for (const entry of deps.store.list()) {
    outcomes.push(await reconcileOne(deps, entry))
  }
  return outcomes
}

/**
 * Reconcile a single entry. Exported so the post-wake handler
 * (DH2 §3) can call it on the same set of entries without
 * rewriting orchestration.
 */
export async function reconcileOne(
  deps: ReconcileDeps,
  entry: ActiveUpload,
): Promise<ReconcileOutcome> {
  const url = `${deps.apiBaseUrl}/api/import/desktop/upload/chunk`
  const http = deps.http ?? axios

  let response: { status: number; data: unknown }
  try {
    response = await http.get(url, {
      params: { sessionId: entry.sessionId },
      headers: { Authorization: `Bearer ${deps.authToken}` },
      timeout: 10_000,
    })
  } catch (err: unknown) {
    // Distinguish 4xx from network failure. axios surfaces HTTP
    // errors via err.response; pure network errors don't carry one.
    const httpErr = err as { response?: { status: number }; message?: string }
    if (httpErr?.response?.status === 404) {
      // Session no longer exists server-side. Clear locally.
      deps.store.remove(entry.sessionId)
      return { kind: "expired", sessionId: entry.sessionId, entry }
    }
    return {
      kind: "unreachable",
      sessionId: entry.sessionId,
      entry,
      error: httpErr?.message ?? String(err),
    }
  }

  const data = response.data as ChunkProbeResponse

  if (TERMINAL_COMPLETED.has(data.uploadStatus)) {
    deps.store.remove(entry.sessionId)
    return { kind: "completed", sessionId: entry.sessionId, entry }
  }

  if (TERMINAL_GONE.has(data.uploadStatus)) {
    // Server marked the session FAILED (stale-session sweep).
    // Treat as expired from the helper's point of view; the user
    // will need to re-detect the archive.
    deps.store.remove(entry.sessionId)
    return { kind: "expired", sessionId: entry.sessionId, entry }
  }

  // Non-terminal — update lastConfirmedChunk to reflect server's
  // view. The server's receivedChunks list is authoritative.
  // We pick the highest contiguous index as the lastConfirmedChunk
  // pointer, so the helper's resume logic never thinks it's
  // further along than the server actually is.
  const sortedReceived = [...data.receivedChunks].sort((a, b) => a - b)
  let highestContiguous = -1
  for (let i = 0; i < sortedReceived.length; i++) {
    if (sortedReceived[i] === i) highestContiguous = i
    else break
  }
  const updatedEntry: ActiveUpload = {
    ...entry,
    lastConfirmedChunk: Math.max(entry.lastConfirmedChunk, highestContiguous),
    lastActivityAt: new Date().toISOString(),
    status: "paused",
  }
  deps.store.upsert(updatedEntry)

  return {
    kind: "resumable",
    sessionId: entry.sessionId,
    entry: updatedEntry,
    partsReceived: data.partsReceived,
    receivedChunks: sortedReceived,
  }
}
