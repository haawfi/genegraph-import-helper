/**
 * DH2 §1 — archive-hash module behavior.
 *
 * Locks the streaming-SHA-256 contract that the server-side
 * dedup route validates against (`^[a-f0-9]{64}$`). The hash
 * MUST be:
 *   - Deterministic — same bytes → same digest, every run.
 *   - Lower-case hex, 64 chars exactly.
 *   - Streaming — multi-GB inputs must not OOM the helper.
 *     We can't feasibly test the OOM path in CI (no GB-scale
 *     fixture), but the implementation uses `createReadStream`
 *     with no buffering, so the streaming property holds by
 *     construction.
 *
 * The `shortFingerprint` helper has its own assertions — the
 * confirmation modal uses it to render an 8-char identifier
 * the user can recognize.
 */

import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createHash } from "crypto"
import { hashArchive, shortFingerprint } from "../archive-hash"

const HEX_RE = /^[a-f0-9]{64}$/

async function writeFixture(content: Buffer | string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "ggih-archive-hash-"))
  const filePath = join(dir, "fixture.bin")
  await fs.writeFile(filePath, content)
  return filePath
}

describe("DH2 §1 — hashArchive", () => {
  test("returns a lower-case 64-character hex digest", async () => {
    const filePath = await writeFixture("hello world")
    const digest = await hashArchive(filePath)
    expect(digest).toMatch(HEX_RE)
    expect(digest.length).toBe(64)
  })

  test("matches the canonical SHA-256 of the same input bytes", async () => {
    const content = "synthetic takeout payload — DH2 §1"
    const filePath = await writeFixture(content)
    const expected = createHash("sha256").update(content).digest("hex")
    const actual = await hashArchive(filePath)
    expect(actual).toBe(expected)
  })

  test("is deterministic across repeated runs", async () => {
    const filePath = await writeFixture(Buffer.from([1, 2, 3, 4, 5]))
    const a = await hashArchive(filePath)
    const b = await hashArchive(filePath)
    expect(a).toBe(b)
  })

  test("produces different digests for different content", async () => {
    const a = await hashArchive(await writeFixture("alpha"))
    const b = await hashArchive(await writeFixture("beta"))
    expect(a).not.toBe(b)
  })

  test("handles binary data correctly (non-UTF-8 bytes)", async () => {
    // Bytes 0x80–0xFF aren't valid UTF-8 in isolation; the hash
    // must process them as bytes, not interpret as text.
    const bytes = Buffer.alloc(256)
    for (let i = 0; i < 256; i++) bytes[i] = i
    const filePath = await writeFixture(bytes)
    const expected = createHash("sha256").update(bytes).digest("hex")
    const actual = await hashArchive(filePath)
    expect(actual).toBe(expected)
  })

  test("rejects when the file does not exist", async () => {
    await expect(hashArchive("/does/not/exist.zip")).rejects.toThrow()
  })
})

describe("DH2 §1 — shortFingerprint", () => {
  test("returns the first 8 characters of the digest", () => {
    const full = "a7f3b2c4d5e6f78901234567890abcdef0123456789abcdef0123456789abcd1"
    expect(shortFingerprint(full)).toBe("a7f3b2c4")
  })

  test("doesn't crash on shorter inputs (defensive)", () => {
    expect(shortFingerprint("ab")).toBe("ab")
    expect(shortFingerprint("")).toBe("")
  })
})
