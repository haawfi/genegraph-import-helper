import yauzl from "yauzl"
import path from "path"
import fs from "fs/promises"

/**
 * TakeoutDetector
 *
 * Reads ZIP file structure to detect if it's a Google Takeout archive.
 * Prioritizes detection correctness over breadth: a false positive
 * (treating a non-Takeout ZIP as Takeout) is worse than missing a
 * borderline archive.
 *
 * Detection criteria (ALL must be met):
 *   1. File has .zip extension
 *   2. File size >= 1 MB (Takeout exports are never trivially small)
 *   3. ZIP central directory contains `Takeout/` root directory
 *   4. ZIP contains Google Takeout marker:
 *      - `Takeout/archive_browser.html` (present in all Takeout exports), OR
 *      - `Takeout/Google Photos/` subdirectory with at least one nested entry
 *   5. Multi-part detection only matches strict Google Takeout naming:
 *      `takeout-YYYYMMDDTHHMMSSZ-NNN.zip`
 *
 * Rejected patterns (prevent false positives):
 *   - ZIP with only `Takeout/` directory but no Google content markers
 *   - ZIP smaller than 1 MB
 *   - Files matching `-NNN.zip` but not the Takeout naming convention
 *   - Corrupt or unreadable ZIP files
 */

export interface TakeoutDetectionResult {
  isTakeout: boolean
  confidence: "high" | "medium" | "none"
  reason?: string              // Human-readable explanation of detection/rejection
  partNumber?: number          // 1-based, only for multi-part
  totalParts?: number          // estimated from filename pattern
  estimatedFiles?: number      // count of entries in ZIP
  fileSizeBytes?: number
}

/** Minimum file size for a valid Takeout export (1 MB) */
const MIN_TAKEOUT_SIZE = 1 * 1024 * 1024

/** Maximum entries to scan before giving up (avoid reading 100k-entry ZIPs fully) */
const MAX_ENTRIES_TO_SCAN = 500

/**
 * Strict regex for Google Takeout multi-part filenames.
 * Matches: takeout-20240101T120000Z-001.zip
 * Does NOT match: report-001.zip, mydata-001.zip
 */
const TAKEOUT_MULTIPART_RE = /^takeout-\d{8}T\d{6}Z-(\d{3})\.zip$/i

/**
 * Relaxed regex for single-part Takeout filenames.
 * Matches: takeout-20240101T120000Z.zip
 */
const TAKEOUT_SINGLE_RE = /^takeout-\d{8}T\d{6}Z\.zip$/i

export class TakeoutDetector {
  /**
   * Detect if a ZIP file is a Google Takeout archive.
   *
   * Returns a result with confidence level:
   *   - "high": definite Takeout (archive_browser.html found + structure matches)
   *   - "medium": likely Takeout (Google Photos dir found, no archive_browser.html)
   *   - "none": not a Takeout archive
   */
  async detect(zipPath: string): Promise<TakeoutDetectionResult> {
    const basename = path.basename(zipPath)

    // ── Gate 1: File size ──────────────────────────────────────────────
    let fileSizeBytes: number
    try {
      const stats = await fs.stat(zipPath)
      fileSizeBytes = stats.size
    } catch {
      return this.reject("File not accessible")
    }

    if (fileSizeBytes < MIN_TAKEOUT_SIZE) {
      return this.reject(`File too small (${fileSizeBytes} bytes, minimum ${MIN_TAKEOUT_SIZE})`)
    }

    // ── Gate 2: Multi-part filename check (strict) ─────────────────────
    const multiPartMatch = this.parseMultiPartFilename(basename)

    // ── Gate 3: ZIP structure analysis ─────────────────────────────────
    let structureResult: ZipStructureResult
    try {
      structureResult = await this.analyzeZipStructure(zipPath)
    } catch (error) {
      return this.reject(`Cannot read ZIP: ${error instanceof Error ? error.message : "unknown error"}`)
    }

    if (!structureResult.hasTakeoutDir) {
      return this.reject("No Takeout/ directory in ZIP root")
    }

    // ── Determine confidence ───────────────────────────────────────────

    // High confidence: archive_browser.html is the definitive Takeout marker
    if (structureResult.hasArchiveBrowser) {
      return {
        isTakeout: true,
        confidence: "high",
        reason: "Google Takeout archive detected (archive_browser.html present)",
        partNumber: multiPartMatch?.partNumber,
        totalParts: multiPartMatch?.totalParts,
        estimatedFiles: structureResult.entryCount,
        fileSizeBytes,
      }
    }

    // Medium confidence: Google Photos dir with nested content (no archive_browser.html)
    // This can happen with older Takeout formats or partial exports
    if (structureResult.hasGooglePhotosWithContent) {
      return {
        isTakeout: true,
        confidence: "medium",
        reason: "Likely Takeout archive (Google Photos directory with content, but no archive_browser.html)",
        partNumber: multiPartMatch?.partNumber,
        totalParts: multiPartMatch?.totalParts,
        estimatedFiles: structureResult.entryCount,
        fileSizeBytes,
      }
    }

    // Has Takeout/ dir but no Google content markers — reject to avoid false positive
    return this.reject(
      "ZIP contains Takeout/ directory but no Google Takeout content markers (archive_browser.html or Google Photos with files)"
    )
  }

  /**
   * Parse filename for strict Google Takeout multi-part pattern.
   *
   * Only matches the exact Google Takeout naming convention:
   *   takeout-20240101T120000Z-001.zip
   *
   * Does NOT match generic `-NNN.zip` patterns to avoid false positives
   * with unrelated numbered archives.
   */
  parseMultiPartFilename(
    basename: string
  ): { partNumber: number; totalParts?: number } | null {
    const match = basename.match(TAKEOUT_MULTIPART_RE)
    if (!match) return null

    return {
      partNumber: parseInt(match[1], 10),
      totalParts: undefined, // Set by MultiPartCollector based on observed parts
    }
  }

  /**
   * Check if a filename matches a known Google Takeout naming pattern
   * (either single-part or multi-part).
   */
  isLikelyTakeoutFilename(basename: string): boolean {
    return TAKEOUT_SINGLE_RE.test(basename) || TAKEOUT_MULTIPART_RE.test(basename)
  }

  /**
   * Analyze ZIP central directory for Takeout structure markers.
   *
   * Scans up to MAX_ENTRIES_TO_SCAN entries to keep detection fast
   * even for large archives. The markers we need are near the top
   * of a Takeout archive.
   */
  private analyzeZipStructure(zipPath: string): Promise<ZipStructureResult> {
    return new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) { reject(err); return }
        if (!zipfile) { resolve(emptyResult()); return }

        const result: ZipStructureResult = {
          hasTakeoutDir: false,
          hasArchiveBrowser: false,
          hasGooglePhotosWithContent: false,
          entryCount: 0,
          googlePhotosNestedEntries: 0,
        }

        let scanned = 0

        const readNext = () => { zipfile.readEntry() }

        zipfile.on("entry", (entry) => {
          scanned++
          result.entryCount++
          const name = entry.fileName

          // Check for Takeout/ root directory
          if (name === "Takeout/" || name.startsWith("Takeout/")) {
            result.hasTakeoutDir = true
          }

          // Check for archive_browser.html (definitive Takeout marker)
          if (name === "Takeout/archive_browser.html") {
            result.hasArchiveBrowser = true
          }

          // Check for Google Photos directory with actual content
          // (not just the directory entry itself)
          if (
            name.startsWith("Takeout/Google Photos/") &&
            name !== "Takeout/Google Photos/" &&
            name.split("/").length >= 4 // At least Takeout/Google Photos/album/file
          ) {
            result.googlePhotosNestedEntries++
            if (result.googlePhotosNestedEntries >= 3) {
              // At least 3 nested files — not just metadata
              result.hasGooglePhotosWithContent = true
            }
          }

          // Early exit if we have high confidence
          if (result.hasArchiveBrowser && result.hasTakeoutDir) {
            zipfile.close()
            resolve(result)
            return
          }

          // Stop scanning after MAX_ENTRIES_TO_SCAN
          if (scanned >= MAX_ENTRIES_TO_SCAN) {
            zipfile.close()
            resolve(result)
            return
          }

          readNext()
        })

        zipfile.on("end", () => resolve(result))
        zipfile.on("error", (e) => {
          // Treat read errors as non-Takeout (don't false-positive on corrupt ZIPs)
          console.warn("[TakeoutDetector] ZIP read error, treating as non-Takeout:", e.message)
          resolve(emptyResult())
        })

        readNext()
      })
    })
  }

  private reject(reason: string): TakeoutDetectionResult {
    return { isTakeout: false, confidence: "none", reason }
  }
}

// ─── Internal Types ───────────────────────────────────────────────────────────

interface ZipStructureResult {
  hasTakeoutDir: boolean
  hasArchiveBrowser: boolean
  hasGooglePhotosWithContent: boolean
  entryCount: number
  googlePhotosNestedEntries: number
}

function emptyResult(): ZipStructureResult {
  return {
    hasTakeoutDir: false,
    hasArchiveBrowser: false,
    hasGooglePhotosWithContent: false,
    entryCount: 0,
    googlePhotosNestedEntries: 0,
  }
}
