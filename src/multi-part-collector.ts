import { EventEmitter } from "events"
import path from "path"
import { TakeoutDetectionResult } from "./takeout-detector"

/**
 * MultiPartCollector
 *
 * Tracks detected Takeout archive parts and waits for complete set.
 * When all parts are detected, emits 'all-parts-ready' event.
 * If timeout occurs before complete set, emits 'timeout' to proceed with available parts.
 *
 * Correctness rules:
 *   - Only groups archives with matching Takeout filename prefixes
 *   - Does NOT assume consecutive parts = complete (could be missing middle parts)
 *   - Waits for timeout before declaring "complete" when totalParts is unknown
 *   - Single-part archives (no partNumber) emit immediately
 *
 * Usage:
 *   const collector = new MultiPartCollector()
 *   collector.on('all-parts-ready', (mainPath, metadata) => { ... })
 *   collector.addPart(filePath, takeoutInfo)
 */
export class MultiPartCollector extends EventEmitter {
  private archiveGroups: Map<
    string,
    {
      baseName: string
      parts: Map<number, string> // partNumber -> filePath
      timeout: NodeJS.Timeout | null
      totalParts: number | null
      lastDetectionResult: TakeoutDetectionResult
    }
  > = new Map()

  private timeoutMs: number

  constructor(timeout: number = 15 * 60 * 1000) {
    super()
    this.timeoutMs = timeout
  }

  /**
   * Add a detected ZIP part to the collector.
   *
   * If this completes a multi-part set, emits 'all-parts-ready' immediately.
   * If timeout elapses, emits 'timeout' with available parts.
   */
  addPart(filePath: string, detectionResult: TakeoutDetectionResult) {
    if (!detectionResult.isTakeout) return

    // For single-part archives (no partNumber), emit immediately
    if (!detectionResult.partNumber) {
      this.emit("all-parts-ready", filePath, {
        ...detectionResult,
        totalParts: 1,
        allPartsFound: [filePath],
      })
      return
    }

    // For multi-part, determine archive group from filename prefix
    const basename = path.basename(filePath)
    const groupKey = this.extractGroupKey(basename)

    if (!groupKey) {
      // Filename doesn't match expected Takeout multi-part pattern
      // Treat as single-part to avoid incorrect grouping
      console.warn(
        `[MultiPartCollector] Cannot extract group key from "${basename}", treating as single-part`
      )
      this.emit("all-parts-ready", filePath, {
        ...detectionResult,
        totalParts: 1,
        allPartsFound: [filePath],
      })
      return
    }

    // Get or create group
    if (!this.archiveGroups.has(groupKey)) {
      this.archiveGroups.set(groupKey, {
        baseName: basename,
        parts: new Map(),
        timeout: null,
        totalParts:
          detectionResult.totalParts && detectionResult.totalParts > 1
            ? detectionResult.totalParts
            : null,
        lastDetectionResult: detectionResult,
      })

      // Set timeout for this group
      const group = this.archiveGroups.get(groupKey)!
      group.timeout = setTimeout(() => {
        this.handleGroupTimeout(groupKey)
      }, this.timeoutMs)
    }

    const group = this.archiveGroups.get(groupKey)!

    // Reject duplicate part numbers (same part detected twice)
    if (group.parts.has(detectionResult.partNumber)) {
      console.warn(
        `[MultiPartCollector] Duplicate part ${detectionResult.partNumber} for "${groupKey}", ignoring`
      )
      return
    }

    group.parts.set(detectionResult.partNumber, filePath)
    group.lastDetectionResult = detectionResult

    console.log(
      `[MultiPartCollector] Part ${detectionResult.partNumber} added to "${groupKey}"` +
        ` (${group.parts.size} parts${group.totalParts ? ` / ${group.totalParts}` : ""})`
    )

    // Check if we have all expected parts (only when totalParts is known)
    if (group.totalParts && group.parts.size === group.totalParts) {
      this.handleGroupComplete(groupKey)
    }
    // When totalParts is unknown, we rely on timeout — do NOT assume
    // consecutive parts from 1 means complete (could be missing later parts)
  }

  /**
   * Extract group key from a strict Takeout multi-part filename.
   *
   * Only matches: takeout-20240101T120000Z-001.zip → "takeout-20240101T120000Z"
   * Returns null for non-matching filenames (prevents incorrect grouping).
   */
  private extractGroupKey(basename: string): string | null {
    // Strict Takeout multi-part pattern
    const match = basename.match(/^(takeout-\d{8}T\d{6}Z)-\d{3}\.zip$/i)
    if (match) return match[1].toLowerCase()
    return null
  }

  /**
   * Handle complete group — emit 'all-parts-ready' with part-1 file path.
   */
  private handleGroupComplete(groupKey: string) {
    const group = this.archiveGroups.get(groupKey)
    if (!group) return

    if (group.timeout) {
      clearTimeout(group.timeout)
      group.timeout = null
    }

    const mainFilePath = group.parts.get(1)
    if (!mainFilePath) {
      console.error(
        `[MultiPartCollector] Group "${groupKey}" complete but part 1 not found`
      )
      // Fall back to lowest-numbered part
      const sortedParts = [...group.parts.entries()].sort((a, b) => a[0] - b[0])
      if (sortedParts.length === 0) {
        this.archiveGroups.delete(groupKey)
        return
      }
      const fallbackPath = sortedParts[0][1]
      this.emitReady(groupKey, group, fallbackPath)
      return
    }

    this.emitReady(groupKey, group, mainFilePath)
  }

  /**
   * Handle timeout — emit 'timeout' with available parts.
   */
  private handleGroupTimeout(groupKey: string) {
    const group = this.archiveGroups.get(groupKey)
    if (!group) return

    console.warn(
      `[MultiPartCollector] Timeout for "${groupKey}": ` +
        `${group.parts.size} parts received (expected ${group.totalParts ?? "unknown"})`
    )

    const mainFilePath = group.parts.get(1)
    if (!mainFilePath) {
      console.warn(`[MultiPartCollector] No part 1 for "${groupKey}", cannot proceed`)
      this.archiveGroups.delete(groupKey)
      return
    }

    const metadata = {
      ...group.lastDetectionResult,
      totalParts: group.parts.size,
      isTimeoutProceed: true,
      allPartsFound: [...group.parts.values()],
    }

    this.emit("timeout", mainFilePath, metadata)
    this.archiveGroups.delete(groupKey)
  }

  private emitReady(
    groupKey: string,
    group: { parts: Map<number, string>; lastDetectionResult: TakeoutDetectionResult },
    mainFilePath: string
  ) {
    console.log(
      `[MultiPartCollector] All parts ready for "${groupKey}": ${group.parts.size} parts`
    )

    const metadata = {
      ...group.lastDetectionResult,
      totalParts: group.parts.size,
      allPartsFound: [...group.parts.values()],
    }

    this.emit("all-parts-ready", mainFilePath, metadata)
    this.archiveGroups.delete(groupKey)
  }

  stop() {
    for (const group of this.archiveGroups.values()) {
      if (group.timeout) clearTimeout(group.timeout)
    }
    this.archiveGroups.clear()
  }
}
