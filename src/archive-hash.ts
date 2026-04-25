import { createHash } from "crypto"
import { createReadStream } from "fs"

/**
 * archive-hash.ts — DH2 §1
 *
 * Streams a SHA-256 digest of a source archive without loading
 * the file into memory. Multi-GB Google Takeout exports are the
 * common case; a buffered hash would OOM the helper on a typical
 * laptop.
 *
 * Why this exists:
 *   - Re-detecting an already-uploaded archive (user re-downloaded
 *     Takeout, or a backup app moved a copy back into the watched
 *     folder) was creating a fresh DesktopUploadSession every time
 *     and re-uploading bytes the server already had. The hash is
 *     the dedup key on the server side (POST
 *     /api/import/desktop/upload now accepts archiveSha256).
 *   - Filename + filesize are too noisy to dedup on
 *     ("Takeout-20240101.zip" vs "Takeout (1).zip" with the same
 *     bytes; two different exports happening to be the same
 *     size). The math says SHA-256 collisions don't happen at
 *     this scale, so a single 64-hex-char fingerprint is enough.
 *
 * Output:
 *   Lower-case hex string, 64 characters. Matches the contract
 *   the server's `archiveSha256` field validates against
 *   (`^[a-f0-9]{64}$`).
 *
 * Performance:
 *   Throughput is bounded by disk read speed — Node's hashing
 *   engine processes >1 GB/sec on commodity hardware. The
 *   default 64 KB chunk size from `createReadStream` keeps
 *   memory bounded regardless of archive size.
 */
export async function hashArchive(archivePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = createReadStream(archivePath)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve(hash.digest("hex")))
    stream.on("error", reject)
  })
}

/**
 * Helper for the confirmation modal's "fingerprint" affordance.
 * Returns the first 8 hex chars of a SHA-256 digest — short
 * enough to read at a glance, long enough to feel like a
 * genuine identifier rather than a placeholder.
 */
export function shortFingerprint(sha256: string): string {
  return sha256.slice(0, 8)
}
