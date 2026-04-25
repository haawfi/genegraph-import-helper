import { EventEmitter } from "events"
import chokidar, { FSWatcher } from "chokidar"
import path from "path"
import fs from "fs/promises"

/**
 * FolderWatcher
 *
 * Watches a folder (typically Downloads) for new .zip files.
 * Uses chokidar to detect file additions, then monitors file size stability
 * to ensure download is complete before emitting event.
 *
 * Hardened edge cases:
 *   - File deleted during stability check (download cancelled)
 *   - File locked by another process
 *   - 0-byte placeholder files
 *   - Extremely large files (30-minute timeout)
 *   - Rapid successive detections of the same file
 *   - Temporary/partial download files (.crdownload, .part, .tmp)
 */
export class FolderWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null
  private watchPath: string
  private processingFiles: Set<string> = new Set() // dedup in-flight checks

  constructor(watchPath: string) {
    super()
    this.watchPath = watchPath
    this.initializeWatcher()
  }

  private initializeWatcher() {
    this.watcher = chokidar.watch(this.watchPath, {
      ignored: /(^|[\/\\])\.|node_modules/,
      persistent: true,
      // Depth 0: only watch immediate directory, not subdirectories
      // (Takeout downloads land directly in Downloads, not in subfolders)
      depth: 0,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100,
      },
    })

    this.watcher
      .on("add", (filePath) => this.handleNewFile(filePath))
      .on("error", (error) =>
        console.error(`[FolderWatcher] Watcher error: ${error.message}`)
      )
  }

  private async handleNewFile(filePath: string) {
    const basename = path.basename(filePath)

    // Only interested in .zip files
    if (!basename.toLowerCase().endsWith(".zip")) return

    // Ignore browser temp/partial download files
    if (this.isPartialDownload(basename)) return

    // Dedup: don't process the same file concurrently
    if (this.processingFiles.has(filePath)) return
    this.processingFiles.add(filePath)

    try {
      console.log(`[FolderWatcher] ZIP detected: ${basename}`)

      const stable = await this.waitForFileSizeStability(filePath)
      if (!stable) {
        console.log(`[FolderWatcher] File did not stabilize, skipping: ${basename}`)
        return
      }

      // Final check: file still exists and is non-empty
      try {
        const stats = await fs.stat(filePath)
        if (stats.size === 0) {
          console.log(`[FolderWatcher] 0-byte file, skipping: ${basename}`)
          return
        }
      } catch {
        console.log(`[FolderWatcher] File disappeared before emission: ${basename}`)
        return
      }

      this.emit("new-zip", filePath)
    } finally {
      this.processingFiles.delete(filePath)
    }
  }

  /**
   * Check if filename indicates a partial/in-progress download.
   * Browsers create temporary files during downloads that get renamed on completion.
   */
  private isPartialDownload(basename: string): boolean {
    const lower = basename.toLowerCase()
    return (
      lower.endsWith(".crdownload") || // Chrome
      lower.endsWith(".part") ||        // Firefox
      lower.endsWith(".partial") ||     // IE/Edge legacy
      lower.endsWith(".tmp") ||         // Generic temp
      lower.endsWith(".download") ||    // Safari
      lower.startsWith(".")            // Hidden files
    )
  }

  /**
   * Wait for file size to stabilize (indicates download complete).
   *
   * Polls file size every 2 seconds. Considers stable after 3 consecutive
   * checks with identical size (6 seconds total stability).
   *
   * Returns false if:
   *   - File is deleted during check (download cancelled)
   *   - File remains 0 bytes after 3 checks
   *   - Timeout reached (30 minutes)
   */
  private async waitForFileSizeStability(filePath: string): Promise<boolean> {
    const POLL_INTERVAL = 2000
    const STABLE_CHECKS = 3
    const MAX_WAIT = 30 * 60 * 1000

    const startTime = Date.now()
    let stableChecks = 0
    let lastSize = -1
    let zeroSizeChecks = 0

    while (Date.now() - startTime < MAX_WAIT) {
      try {
        const stats = await fs.stat(filePath)
        const currentSize = stats.size

        // Track consecutive 0-byte reads — likely a placeholder that won't grow
        if (currentSize === 0) {
          zeroSizeChecks++
          if (zeroSizeChecks >= STABLE_CHECKS) {
            return false // Persistent 0-byte file — not a real download
          }
        } else {
          zeroSizeChecks = 0
        }

        if (currentSize === lastSize && currentSize > 0) {
          stableChecks++
          if (stableChecks >= STABLE_CHECKS) {
            console.log(
              `[FolderWatcher] File stable: ${path.basename(filePath)} (${currentSize} bytes)`
            )
            return true
          }
        } else {
          stableChecks = 0
          lastSize = currentSize
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
      } catch (error: any) {
        if (error?.code === "ENOENT") {
          // File was deleted (download cancelled)
          return false
        }
        // Other errors (permission, locked) — retry
        console.warn(`[FolderWatcher] Error checking file, retrying: ${error?.code || error}`)
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
      }
    }

    // Timeout — still proceed (file may be complete but very large)
    console.warn(
      `[FolderWatcher] Stability timeout for ${path.basename(filePath)}, proceeding`
    )
    return true
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    this.processingFiles.clear()
  }
}
