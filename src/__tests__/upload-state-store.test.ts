/**
 * DH2 §2 — UploadStateStore behavior.
 *
 * Locks the persistence contract that the helper's startup
 * reconciliation relies on:
 *   - JSON file in `app.getPath("userData")/upload-state.json`.
 *   - Atomic writes via tmp-file + rename (no partial-write
 *     corruption).
 *   - Corruption recovery: malformed JSON / missing file →
 *     start fresh (do NOT crash the helper).
 *   - Schema-version gate: an unknown version drops everything.
 *   - Defensive shape validation: malformed entries in a
 *     parseable file get dropped silently.
 *
 * The mocked Electron module routes app.getPath('userData') to a
 * jest-managed tmpdir so each test gets isolated state.
 */

import * as fs from "fs"
import * as path from "path"
import { UploadStateStore, type ActiveUpload } from "../upload-state-store"

// The electron mock under src/__tests__/__mocks__ provides
// app.getPath('userData') → a tmpdir created at test-run start.
// Reset the file before every test so we get a clean store.
import { app } from "electron"

function fixturePath(): string {
  return path.join(app.getPath("userData"), "upload-state.json")
}

function makeUpload(overrides: Partial<ActiveUpload> = {}): ActiveUpload {
  return {
    sessionId: "session-A",
    archivePath: "/tmp/takeout.zip",
    archiveSha256: "a".repeat(64),
    totalBytes: 1_000_000,
    partsExpected: 4,
    lastConfirmedChunk: -1,
    startedAt: "2026-04-25T00:00:00.000Z",
    lastActivityAt: "2026-04-25T00:00:00.000Z",
    status: "uploading",
    ...overrides,
  }
}

beforeEach(() => {
  // Wipe any state file written by a prior test in the same run.
  try {
    fs.unlinkSync(fixturePath())
  } catch {
    /* missing — fine */
  }
  try {
    fs.unlinkSync(`${fixturePath()}.tmp`)
  } catch {
    /* missing — fine */
  }
})

describe("DH2 §2 — UploadStateStore basic CRUD", () => {
  test("a fresh store with no file yields an empty list", () => {
    const store = new UploadStateStore()
    expect(store.list()).toEqual([])
  })

  test("upsert + get round-trips an upload", () => {
    const store = new UploadStateStore()
    const upload = makeUpload()
    store.upsert(upload)
    expect(store.get("session-A")).toEqual(upload)
  })

  test("upsert with the same id overwrites the prior entry", () => {
    const store = new UploadStateStore()
    store.upsert(makeUpload({ lastConfirmedChunk: 0 }))
    store.upsert(makeUpload({ lastConfirmedChunk: 2 }))
    expect(store.get("session-A")?.lastConfirmedChunk).toBe(2)
  })

  test("list returns every active upload", () => {
    const store = new UploadStateStore()
    store.upsert(makeUpload({ sessionId: "s1" }))
    store.upsert(makeUpload({ sessionId: "s2" }))
    expect(store.list()).toHaveLength(2)
    expect(store.list().map((u) => u.sessionId).sort()).toEqual(["s1", "s2"])
  })

  test("remove deletes one entry without affecting others", () => {
    const store = new UploadStateStore()
    store.upsert(makeUpload({ sessionId: "s1" }))
    store.upsert(makeUpload({ sessionId: "s2" }))
    store.remove("s1")
    expect(store.list().map((u) => u.sessionId)).toEqual(["s2"])
  })

  test("remove on an unknown id is a silent no-op", () => {
    const store = new UploadStateStore()
    store.upsert(makeUpload({ sessionId: "s1" }))
    expect(() => store.remove("never-existed")).not.toThrow()
    expect(store.list()).toHaveLength(1)
  })
})

describe("DH2 §2 — UploadStateStore chunk + lifecycle helpers", () => {
  test("recordChunkConfirmed advances lastConfirmedChunk monotonically", () => {
    const store = new UploadStateStore()
    store.upsert(makeUpload({ lastConfirmedChunk: 0 }))
    store.recordChunkConfirmed("session-A", 5)
    expect(store.get("session-A")?.lastConfirmedChunk).toBe(5)
    // An older chunk arriving later (out-of-order POST acks)
    // should NOT regress the pointer.
    store.recordChunkConfirmed("session-A", 3)
    expect(store.get("session-A")?.lastConfirmedChunk).toBe(5)
  })

  test("recordChunkConfirmed sets status back to uploading", () => {
    const store = new UploadStateStore()
    store.upsert(makeUpload({ status: "paused" }))
    store.recordChunkConfirmed("session-A", 1)
    expect(store.get("session-A")?.status).toBe("uploading")
  })

  test("recordChunkConfirmed on an unknown id is a silent no-op", () => {
    const store = new UploadStateStore()
    expect(() => store.recordChunkConfirmed("never-existed", 1)).not.toThrow()
    expect(store.list()).toHaveLength(0)
  })

  test("markAllPaused flips every entry's status to paused", () => {
    const store = new UploadStateStore()
    store.upsert(makeUpload({ sessionId: "s1", status: "uploading" }))
    store.upsert(makeUpload({ sessionId: "s2", status: "uploading" }))
    store.markAllPaused()
    for (const u of store.list()) expect(u.status).toBe("paused")
  })

  test("markFailed sets status + failureReason without removing the entry", () => {
    const store = new UploadStateStore()
    store.upsert(makeUpload())
    store.markFailed("session-A", "auth expired")
    const after = store.get("session-A")!
    expect(after.status).toBe("failed")
    expect(after.failureReason).toBe("auth expired")
  })

  test("clearAll wipes the entire store", () => {
    const store = new UploadStateStore()
    store.upsert(makeUpload({ sessionId: "s1" }))
    store.upsert(makeUpload({ sessionId: "s2" }))
    store.clearAll()
    expect(store.list()).toEqual([])
  })
})

describe("DH2 §2 — UploadStateStore persistence + corruption recovery", () => {
  test("upsert persists to disk; a fresh instance reads the same state", () => {
    const a = new UploadStateStore()
    a.upsert(makeUpload({ sessionId: "persisted-1" }))
    const b = new UploadStateStore()
    expect(b.get("persisted-1")?.sessionId).toBe("persisted-1")
  })

  test("save uses atomic tmp-file + rename pattern", () => {
    const store = new UploadStateStore()
    store.upsert(makeUpload())
    // After a successful save, the live file exists and the tmp
    // is gone.
    expect(fs.existsSync(fixturePath())).toBe(true)
    expect(fs.existsSync(`${fixturePath()}.tmp`)).toBe(false)
  })

  test("malformed JSON on disk → start fresh, no crash", () => {
    fs.writeFileSync(fixturePath(), "{ not valid json", "utf-8")
    const store = new UploadStateStore()
    expect(store.list()).toEqual([])
  })

  test("unknown schema version → drop everything, start fresh", () => {
    fs.writeFileSync(
      fixturePath(),
      JSON.stringify({
        version: 99,
        uploads: { "session-A": makeUpload() },
      }),
      "utf-8",
    )
    const store = new UploadStateStore()
    expect(store.list()).toEqual([])
  })

  test("entries with missing required fields are dropped silently", () => {
    fs.writeFileSync(
      fixturePath(),
      JSON.stringify({
        version: 1,
        uploads: {
          "session-A": makeUpload(),
          "session-B": { sessionId: "session-B" }, // missing fields
        },
      }),
      "utf-8",
    )
    const store = new UploadStateStore()
    const ids = store.list().map((u) => u.sessionId)
    expect(ids).toEqual(["session-A"])
  })

  test("entries with invalid status values are dropped silently", () => {
    fs.writeFileSync(
      fixturePath(),
      JSON.stringify({
        version: 1,
        uploads: {
          "session-A": { ...makeUpload(), status: "weird-state" },
        },
      }),
      "utf-8",
    )
    const store = new UploadStateStore()
    expect(store.list()).toEqual([])
  })
})
