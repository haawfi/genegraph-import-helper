import axios, { AxiosError } from "axios"
import fs from "fs/promises"
import path from "path"
import { isInPostWakeWindow } from "./wake-clock"
import { classifyError } from "./error-classification"

/**
 * ChunkedUploader
 *
 * Uploads a ZIP file in 5MB chunks with:
 *   - Server-confirmed progress (receivedChunks is the source of truth)
 *   - Resume from server state (queries received chunks before starting)
 *   - Per-chunk retry with exponential backoff (3 attempts)
 *   - Network connectivity check before starting
 *   - Honest progress reporting (only shows server-confirmed bytes)
 *
 * Standing rules (founder-mandated):
 *   1. False certainty is worse than a delayed upload — never report
 *      progress the server hasn't confirmed.
 *   2. The user must always understand what the app is doing — every
 *      state (uploading, retrying, paused, failed) is surfaced.
 *   3. Server-confirmed progress is the source of truth — local byte
 *      counters are never used for resume or progress display.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UploadProgress {
  /** Current state — always honest about what's happening */
  state: "querying_server" | "uploading" | "retrying" | "failed" | "complete"
  /** Server-confirmed bytes uploaded (source of truth) */
  uploadedBytes: number
  /** Total file size in bytes */
  totalBytes: number
  /** Server-confirmed progress 0-100 */
  progress: number
  /** Current chunk index being uploaded (0-based) */
  currentChunk: number
  /** Total chunks */
  totalChunks: number
  /** Chunks the server has confirmed receiving */
  receivedChunks: number[]
  /** Human-readable status for UI display */
  statusMessage: string
  /** If state is "retrying", which attempt (1-based) */
  retryAttempt?: number
  /** If state is "failed", the error message */
  errorMessage?: string
  /** DH2 §4 — error classification when state is "failed". Lets
   *  the consumer (main.ts) react differently to auth-fail
   *  (route to login) vs permanent-fail (mark failed; don't
   *  requeue) vs transient/retry (existing behavior). */
  errorCategory?: "transient" | "retry" | "auth-fail" | "permanent-fail"
  /** DH2 §4 — HTTP status when applicable. Surfaced so the
   *  consumer can render permanentFailMessage(status). */
  httpStatus?: number
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CHUNK_SIZE = 5 * 1024 * 1024 // 5 MB
const MAX_RETRIES = 3
const BASE_RETRY_DELAY_MS = 1000 // 1s, 2s, 4s exponential
const CHUNK_UPLOAD_TIMEOUT_MS = 60_000 // 60s per chunk (large files on slow networks)

export class ChunkedUploader {
  private readonly apiBaseUrl: string
  private readonly authToken: string
  private aborted = false

  constructor(apiBaseUrl: string, authToken: string) {
    this.apiBaseUrl = apiBaseUrl
    this.authToken = authToken
  }

  /**
   * Upload a ZIP file in chunks with resume support.
   *
   * Yields server-confirmed progress updates. The consumer should
   * display these directly — they are honest about the current state.
   */
  async *uploadZip(
    filePath: string,
    sessionId: string
  ): AsyncGenerator<UploadProgress> {
    this.aborted = false

    // ── Step 1: Read file metadata ────────────────────────────────────
    const stats = await fs.stat(filePath)
    const totalBytes = stats.size
    const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE)
    const filename = path.basename(filePath)

    console.log(
      `[Uploader] Starting: ${filename} (${totalBytes} bytes, ${totalChunks} chunks)`
    )

    // ── Step 2: Query server for already-received chunks ──────────────
    yield {
      state: "querying_server",
      uploadedBytes: 0,
      totalBytes,
      progress: 0,
      currentChunk: 0,
      totalChunks,
      receivedChunks: [],
      statusMessage: "Checking server for previous progress...",
    }

    let serverState: { receivedChunks: number[]; uploadedBytes: number }
    try {
      serverState = await this.queryReceivedChunks(sessionId)
    } catch {
      // Can't reach server — start from zero
      serverState = { receivedChunks: [], uploadedBytes: 0 }
    }

    const alreadyReceived = new Set(serverState.receivedChunks)
    const chunksToUpload = []
    for (let i = 0; i < totalChunks; i++) {
      if (!alreadyReceived.has(i)) chunksToUpload.push(i)
    }

    if (chunksToUpload.length === 0) {
      yield {
        state: "complete",
        uploadedBytes: totalBytes,
        totalBytes,
        progress: 100,
        currentChunk: totalChunks - 1,
        totalChunks,
        receivedChunks: serverState.receivedChunks,
        statusMessage: "Upload already complete",
      }
      return
    }

    if (alreadyReceived.size > 0) {
      console.log(
        `[Uploader] Resuming: ${alreadyReceived.size}/${totalChunks} chunks already on server`
      )
    }

    // ── Step 3: Upload remaining chunks ───────────────────────────────
    const fileHandle = await fs.open(filePath, "r")
    const buffer = Buffer.alloc(CHUNK_SIZE)
    let confirmedReceivedChunks = [...serverState.receivedChunks]
    let confirmedUploadedBytes = serverState.uploadedBytes

    try {
      for (const chunkIndex of chunksToUpload) {
        if (this.aborted) break

        // Read chunk from file
        const offset = chunkIndex * CHUNK_SIZE
        const { bytesRead } = await fileHandle.read(buffer, 0, CHUNK_SIZE, offset)
        if (bytesRead === 0) break
        const chunk = buffer.subarray(0, bytesRead)

        // Upload with retry
        const result = await this.uploadChunkWithRetry(
          sessionId,
          chunkIndex,
          totalChunks,
          totalBytes,
          chunk,
          function* (attempt) {
            // Yield retry progress (generator delegation)
          }
        )

        if (result.success) {
          confirmedReceivedChunks = result.receivedChunks!
          confirmedUploadedBytes = result.uploadedBytes!
          const progress = totalBytes > 0
            ? Math.round((confirmedUploadedBytes / totalBytes) * 100)
            : 0

          yield {
            state: "uploading",
            uploadedBytes: confirmedUploadedBytes,
            totalBytes,
            progress,
            currentChunk: chunkIndex,
            totalChunks,
            receivedChunks: confirmedReceivedChunks,
            statusMessage: `Uploading chunk ${confirmedReceivedChunks.length}/${totalChunks}`,
          }
        } else {
          // All retries exhausted (or auth-fail / permanent-fail
          // short-circuit). Surface the classification so main.ts
          // can decide whether to route to login, show a
          // permanent-failure notification, or requeue.
          yield {
            state: "failed",
            uploadedBytes: confirmedUploadedBytes,
            totalBytes,
            progress: totalBytes > 0
              ? Math.round((confirmedUploadedBytes / totalBytes) * 100)
              : 0,
            currentChunk: chunkIndex,
            totalChunks,
            receivedChunks: confirmedReceivedChunks,
            statusMessage: `Upload failed at chunk ${chunkIndex + 1}/${totalChunks}`,
            errorMessage: result.error,
            errorCategory: result.category,
            httpStatus: result.httpStatus,
          }
          return
        }
      }
    } finally {
      await fileHandle.close()
    }

    if (this.aborted) {
      yield {
        state: "failed",
        uploadedBytes: confirmedUploadedBytes,
        totalBytes,
        progress: totalBytes > 0
          ? Math.round((confirmedUploadedBytes / totalBytes) * 100)
          : 0,
        currentChunk: 0,
        totalChunks,
        receivedChunks: confirmedReceivedChunks,
        statusMessage: "Upload cancelled",
        errorMessage: "Upload was cancelled by user",
      }
      return
    }

    // ── Step 4: Verify completion with server ─────────────────────────
    // Don't trust local state — ask the server
    let finalState: { receivedChunks: number[]; uploadedBytes: number; uploadStatus: string }
    try {
      finalState = await this.queryReceivedChunks(sessionId)
    } catch {
      finalState = {
        receivedChunks: confirmedReceivedChunks,
        uploadedBytes: confirmedUploadedBytes,
        uploadStatus: "UPLOADING",
      }
    }

    const isComplete = finalState.receivedChunks.length === totalChunks

    yield {
      state: isComplete ? "complete" : "uploading",
      uploadedBytes: finalState.uploadedBytes,
      totalBytes,
      progress: isComplete ? 100 : Math.round((finalState.uploadedBytes / totalBytes) * 100),
      currentChunk: totalChunks - 1,
      totalChunks,
      receivedChunks: finalState.receivedChunks,
      statusMessage: isComplete
        ? "Upload complete (server confirmed)"
        : `Upload incomplete: server has ${finalState.receivedChunks.length}/${totalChunks} chunks`,
    }
  }

  /**
   * Abort an in-progress upload. The upload generator will yield a "failed" state.
   */
  abort(): void {
    this.aborted = true
  }

  /**
   * Check if the server is reachable.
   */
  async checkConnectivity(): Promise<boolean> {
    try {
      await axios.get(`${this.apiBaseUrl}/api/auth/desktop/verify`, {
        headers: { Authorization: `Bearer ${this.authToken}` },
        timeout: 5000,
      })
      return true
    } catch {
      return false
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────

  /**
   * Query the server for which chunks it has received.
   * This is the ONLY source of truth for resume.
   */
  private async queryReceivedChunks(
    sessionId: string
  ): Promise<{ receivedChunks: number[]; uploadedBytes: number; uploadStatus: string }> {
    const response = await axios.get(
      `${this.apiBaseUrl}/api/import/desktop/upload/chunk`,
      {
        params: { sessionId },
        headers: { Authorization: `Bearer ${this.authToken}` },
        timeout: 10000,
      }
    )
    return response.data
  }

  /**
   * Upload a single chunk with exponential backoff retry.
   */
  private async uploadChunkWithRetry(
    sessionId: string,
    chunkIndex: number,
    totalChunks: number,
    totalBytes: number,
    chunkData: Buffer,
    _onRetry: (attempt: number) => Generator
  ): Promise<{
    success: boolean
    receivedChunks?: number[]
    uploadedBytes?: number
    error?: string
    /** DH2 §4 — only populated on failure. */
    category?: "transient" | "retry" | "auth-fail" | "permanent-fail"
    /** DH2 §4 — only populated on failure. */
    httpStatus?: number
  }> {
    // DH2 §3 — `attempt` advances on every failure that counts
    // against the budget. Failures inside the post-wake tolerance
    // window (30s after a powerMonitor "resume" event) DON'T
    // increment the counter; they're treated as expected
    // network-still-stabilizing flakes per the spec. The post-
    // wake exemption stops counting after the window closes, so
    // a server that's genuinely down doesn't get infinite
    // retries.
    let attempt = 1
    while (attempt <= MAX_RETRIES) {
      try {
        const formData = new FormData()
        formData.append("sessionId", sessionId)
        formData.append("chunkIndex", chunkIndex.toString())
        formData.append("totalChunks", totalChunks.toString())
        formData.append("totalBytes", totalBytes.toString())
        formData.append("chunkData", new Blob([chunkData]))

        const response = await axios.post(
          `${this.apiBaseUrl}/api/import/desktop/upload/chunk`,
          formData,
          {
            headers: {
              Authorization: `Bearer ${this.authToken}`,
              "Content-Type": "multipart/form-data",
            },
            timeout: CHUNK_UPLOAD_TIMEOUT_MS,
          }
        )

        // Server confirmed this chunk — use its response as truth
        return {
          success: true,
          receivedChunks: response.data.receivedChunks,
          uploadedBytes: response.data.uploadedBytes,
        }
      } catch (error) {
        const errMsg = error instanceof AxiosError
          ? error.response?.data?.error || error.message
          : String(error)
        const httpStatus =
          error instanceof AxiosError ? error.response?.status : undefined
        const category = classifyError(error)

        // DH2 §4 — auth-fail / permanent-fail short-circuit.
        // Retrying these is wasted motion: a 401 needs the user
        // to re-login, a 413 will never succeed, etc. Short-
        // circuit returns the category so main.ts can render
        // the right UX (auth flow vs failure notification vs
        // requeue).
        if (category === "auth-fail" || category === "permanent-fail") {
          console.warn(
            `[Uploader] Chunk ${chunkIndex} hit ${category} (HTTP ${httpStatus ?? "?"}); not retrying: ${errMsg}`,
          )
          return {
            success: false,
            error: errMsg,
            category,
            httpStatus,
          }
        }

        // DH2 §3 — post-wake exemption. Don't increment `attempt`,
        // don't decrement the budget. Just log + short delay +
        // try again. The window caps at 30s after the most
        // recent OS wake; outside it, normal retry budget
        // applies. Only applies to transient/retry categories,
        // since auth-fail / permanent-fail already returned above.
        if (isInPostWakeWindow()) {
          console.warn(
            `[Uploader] Chunk ${chunkIndex} failed within the post-wake tolerance window; not counting against retry budget: ${errMsg}`,
          )
          await new Promise((resolve) => setTimeout(resolve, 2_000))
          continue
        }

        const isLast = attempt === MAX_RETRIES
        if (isLast) {
          console.error(
            `[Uploader] Chunk ${chunkIndex} failed after ${MAX_RETRIES} attempts: ${errMsg}`
          )
          return { success: false, error: errMsg, category, httpStatus }
        }

        // Exponential backoff: 1s, 2s, 4s
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1)
        console.warn(
          `[Uploader] Chunk ${chunkIndex} attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay}ms: ${errMsg}`
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
        attempt++
      }
    }

    // Unreachable, but TypeScript needs it
    return { success: false, error: "Max retries exceeded" }
  }
}
