import { app } from "electron"
import path from "path"
import fs from "fs"

/**
 * UploadStateStore — DH2 §2
 *
 * Persists in-progress upload state to a JSON file in the helper's
 * userData directory so a crash mid-upload doesn't lose context.
 * On next launch the helper reads this file, queries the server
 * for the canonical state of each session via the DH2 §0 GET
 * resume probe, and either resumes (banner shown), surfaces
 * "completed in your absence" (cleanup), or clears stale entries.
 *
 * Why a flat JSON file instead of SQLite:
 *   - There's never more than 1–2 active uploads in flight (the
 *     uploadQueue is single-threaded; concurrent archives are
 *     queued, not parallelized).
 *   - No transactional requirements. Every write replaces the
 *     entire state; we never need consistent multi-row updates.
 *   - SQLite means a native module rebuild per Electron version
 *     bump. The R1 / R1.1 strategy doc mandates a narrow native-
 *     module surface; this is the wrong place to widen it.
 *
 * File path:
 *   macOS:   ~/Library/Application Support/GeneGraph Import Helper/upload-state.json
 *   Windows: %APPDATA%/GeneGraph Import Helper/upload-state.json
 *   Linux:   ~/.config/GeneGraph Import Helper/upload-state.json
 *
 * Atomic writes:
 *   Every save writes to `<file>.tmp` first, then renames over
 *   the live file. Rename is atomic on POSIX (rename(2)) and on
 *   Windows for files in the same directory (MoveFileExW). This
 *   prevents partial writes from corrupting the store mid-flush.
 *
 * Corruption recovery:
 *   On read, malformed JSON / missing file / unreadable bytes
 *   produce a fresh empty state. We log a warning but never
 *   crash — active uploads at the moment of corruption are lost,
 *   which is acceptable for a recovery-only data store.
 */

export type UploadStateStatus = "uploading" | "paused" | "failed"

export interface ActiveUpload {
  /** Server-side DesktopUploadSession id. */
  sessionId: string
  /** Absolute path to the source archive on disk. */
  archivePath: string
  /** SHA-256 hex digest of the archive. Always set in DH2;
   *  legacy migration is a non-concern (alpha testers re-detect). */
  archiveSha256: string
  totalBytes: number
  partsExpected: number
  /** Highest contiguous chunk index the server has confirmed.
   *  This is a hint; the server's GET resume probe is always
   *  the source of truth on next-launch reconciliation. */
  lastConfirmedChunk: number
  startedAt: string
  lastActivityAt: string
  status: UploadStateStatus
  failureReason?: string
}

interface UploadStateFile {
  /** Schema version; incremented when the on-disk shape changes
   *  in a non-additive way. */
  version: 1
  uploads: Record<string, ActiveUpload>
}

const SCHEMA_VERSION = 1

const EMPTY_STATE: UploadStateFile = { version: SCHEMA_VERSION, uploads: {} }

export class UploadStateStore {
  private filePath: string
  private state: UploadStateFile

  constructor() {
    const userDataPath = app.getPath("userData")
    this.filePath = path.join(userDataPath, "upload-state.json")
    this.state = this.load()
  }

  /** Returns a snapshot of all active uploads, keyed by sessionId. */
  list(): ActiveUpload[] {
    return Object.values(this.state.uploads)
  }

  /** Returns one upload by session id, or undefined. */
  get(sessionId: string): ActiveUpload | undefined {
    return this.state.uploads[sessionId]
  }

  /**
   * Insert or replace an upload. Used at upload-start (full record),
   * after every confirmed chunk (lastConfirmedChunk +
   * lastActivityAt updates), and on transition to paused / failed.
   */
  upsert(upload: ActiveUpload): void {
    this.state.uploads[upload.sessionId] = upload
    this.save()
  }

  /**
   * Update the last-confirmed chunk + activity timestamp for an
   * existing entry. No-op (silent) if the session id is unknown —
   * the helper might still be recording a chunk after the entry
   * was cleared by a parallel completion path.
   */
  recordChunkConfirmed(sessionId: string, chunkIndex: number): void {
    const existing = this.state.uploads[sessionId]
    if (!existing) return
    if (chunkIndex > existing.lastConfirmedChunk) {
      existing.lastConfirmedChunk = chunkIndex
    }
    existing.lastActivityAt = new Date().toISOString()
    existing.status = "uploading"
    this.save()
  }

  /**
   * Mark every active upload paused. Called from the powerMonitor
   * suspend handler in main.ts (DH2 §3) so the next-launch
   * reconciler knows to query the server for canonical state.
   */
  markAllPaused(): void {
    for (const sessionId of Object.keys(this.state.uploads)) {
      this.state.uploads[sessionId].status = "paused"
    }
    this.save()
  }

  /** Drop a single entry from the store. Called on completion or
   *  on user-initiated cancel. */
  remove(sessionId: string): void {
    if (sessionId in this.state.uploads) {
      delete this.state.uploads[sessionId]
      this.save()
    }
  }

  /** Mark a single upload as failed with a reason. */
  markFailed(sessionId: string, reason: string): void {
    const existing = this.state.uploads[sessionId]
    if (!existing) return
    existing.status = "failed"
    existing.failureReason = reason
    existing.lastActivityAt = new Date().toISOString()
    this.save()
  }

  /** Wipe the entire store. Test helper; not used in main.ts. */
  clearAll(): void {
    this.state = { ...EMPTY_STATE, uploads: {} }
    this.save()
  }

  /** Where the store persists. Exposed for tests + diagnostics. */
  getFilePath(): string {
    return this.filePath
  }

  // ─── Internal ─────────────────────────────────────────────────

  private load(): UploadStateFile {
    try {
      if (!fs.existsSync(this.filePath)) return { ...EMPTY_STATE, uploads: {} }
      const raw = fs.readFileSync(this.filePath, "utf-8")
      const parsed = JSON.parse(raw) as Partial<UploadStateFile>
      // Forward-compat: drop entries from a future schema we
      // don't understand. The version check is intentionally
      // strict — silently coercing unknown shapes invites
      // corruption-by-presumption.
      if (parsed.version !== SCHEMA_VERSION) {
        console.warn(
          `[UploadStateStore] Unknown schema version ${parsed.version}; starting fresh.`,
        )
        return { ...EMPTY_STATE, uploads: {} }
      }
      // Defensive shape check on the uploads dict — anything that
      // doesn't look like an ActiveUpload gets dropped.
      const uploads: Record<string, ActiveUpload> = {}
      for (const [k, v] of Object.entries(parsed.uploads ?? {})) {
        if (this.isValidActiveUpload(v)) uploads[k] = v
      }
      return { version: SCHEMA_VERSION, uploads }
    } catch (err) {
      console.warn(
        "[UploadStateStore] Failed to load upload state, starting fresh:",
        err,
      )
      return { ...EMPTY_STATE, uploads: {} }
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const tmp = `${this.filePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8")
      // Atomic on POSIX; atomic-within-volume on Windows.
      fs.renameSync(tmp, this.filePath)
    } catch (err) {
      console.error("[UploadStateStore] Failed to save upload state:", err)
    }
  }

  private isValidActiveUpload(v: unknown): v is ActiveUpload {
    if (typeof v !== "object" || v === null) return false
    const o = v as Record<string, unknown>
    return (
      typeof o.sessionId === "string" &&
      typeof o.archivePath === "string" &&
      typeof o.archiveSha256 === "string" &&
      typeof o.totalBytes === "number" &&
      typeof o.partsExpected === "number" &&
      typeof o.lastConfirmedChunk === "number" &&
      typeof o.startedAt === "string" &&
      typeof o.lastActivityAt === "string" &&
      (o.status === "uploading" ||
        o.status === "paused" ||
        o.status === "failed")
    )
  }
}
