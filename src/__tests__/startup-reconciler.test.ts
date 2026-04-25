/**
 * DH2 §2 — startup reconciler outcomes.
 *
 * On helper startup, every active upload in the local store is
 * cross-checked against the server's canonical state via the
 * DH2 §0 GET resume probe. Each entry produces one of four
 * outcomes:
 *   - completed     → server says COMPLETED → store cleared.
 *   - resumable     → server says non-terminal → store updated;
 *                     caller renders banner.
 *   - expired       → server returns 404 OR FAILED → store
 *                     cleared.
 *   - unreachable   → network error → store left as-is.
 *
 * The reconciler is pure logic; it doesn't render UI. The
 * caller (main.ts) orchestrates banners + tray updates.
 */

import { reconcileOne } from "../startup-reconciler"
import { UploadStateStore, type ActiveUpload } from "../upload-state-store"
import * as fs from "fs"
import * as path from "path"
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
  try {
    fs.unlinkSync(fixturePath())
  } catch {
    /* missing — fine */
  }
})

describe("DH2 §2 — startup reconciler", () => {
  test("server says COMPLETED → outcome is completed + entry removed from store", async () => {
    const store = new UploadStateStore()
    store.upsert(makeUpload())

    const http = {
      get: jest.fn().mockResolvedValue({
        status: 200,
        data: {
          sessionId: "session-A",
          uploadStatus: "COMPLETED",
          partsExpected: 4,
          partsReceived: 4,
          receivedChunks: [0, 1, 2, 3],
          uploadedBytes: 1_000_000,
          totalBytes: 1_000_000,
        },
      }),
    }

    const outcome = await reconcileOne(
      { apiBaseUrl: "https://example.com", authToken: "tok", store, http },
      makeUpload(),
    )

    expect(outcome.kind).toBe("completed")
    expect(store.list()).toEqual([])
  })

  test("server says UPLOADING → outcome is resumable + lastConfirmedChunk advances", async () => {
    const store = new UploadStateStore()
    store.upsert(makeUpload({ lastConfirmedChunk: 0 }))

    const http = {
      get: jest.fn().mockResolvedValue({
        status: 200,
        data: {
          sessionId: "session-A",
          uploadStatus: "UPLOADING",
          partsExpected: 4,
          partsReceived: 2,
          receivedChunks: [0, 1],
          uploadedBytes: 524_288,
          totalBytes: 1_000_000,
        },
      }),
    }

    const outcome = await reconcileOne(
      { apiBaseUrl: "https://example.com", authToken: "tok", store, http },
      makeUpload({ lastConfirmedChunk: 0 }),
    )

    expect(outcome.kind).toBe("resumable")
    if (outcome.kind === "resumable") {
      expect(outcome.partsReceived).toBe(2)
      expect(outcome.receivedChunks).toEqual([0, 1])
      expect(outcome.entry.lastConfirmedChunk).toBe(1)
      expect(outcome.entry.status).toBe("paused")
    }
    expect(store.get("session-A")?.lastConfirmedChunk).toBe(1)
  })

  test("highestContiguous handles non-contiguous receivedChunks correctly", async () => {
    // Server received [0, 1, 4] — chunk 2 + 3 are missing. The
    // local lastConfirmedChunk pointer should be 1 (highest in-
    // order index), NOT 4. Otherwise the helper's resume logic
    // would wrongly skip chunks 2 + 3.
    const store = new UploadStateStore()
    store.upsert(makeUpload())
    const http = {
      get: jest.fn().mockResolvedValue({
        status: 200,
        data: {
          sessionId: "session-A",
          uploadStatus: "UPLOADING",
          partsExpected: 5,
          partsReceived: 3,
          receivedChunks: [0, 1, 4],
          uploadedBytes: 800_000,
          totalBytes: 1_000_000,
        },
      }),
    }

    const outcome = await reconcileOne(
      { apiBaseUrl: "https://example.com", authToken: "tok", store, http },
      makeUpload(),
    )

    if (outcome.kind === "resumable") {
      expect(outcome.entry.lastConfirmedChunk).toBe(1)
      expect(outcome.receivedChunks).toEqual([0, 1, 4])
    }
  })

  test("server returns 404 → outcome is expired + entry removed", async () => {
    const store = new UploadStateStore()
    store.upsert(makeUpload())

    const http = {
      get: jest.fn().mockRejectedValue({
        response: { status: 404 },
        message: "Request failed with status code 404",
      }),
    }

    const outcome = await reconcileOne(
      { apiBaseUrl: "https://example.com", authToken: "tok", store, http },
      makeUpload(),
    )

    expect(outcome.kind).toBe("expired")
    expect(store.list()).toEqual([])
  })

  test("server says FAILED → outcome is expired + entry removed", async () => {
    const store = new UploadStateStore()
    store.upsert(makeUpload())

    const http = {
      get: jest.fn().mockResolvedValue({
        status: 200,
        data: {
          sessionId: "session-A",
          uploadStatus: "FAILED",
          partsExpected: 4,
          partsReceived: 1,
          receivedChunks: [0],
          uploadedBytes: 256_000,
          totalBytes: 1_000_000,
        },
      }),
    }

    const outcome = await reconcileOne(
      { apiBaseUrl: "https://example.com", authToken: "tok", store, http },
      makeUpload(),
    )

    expect(outcome.kind).toBe("expired")
    expect(store.list()).toEqual([])
  })

  test("network error → outcome is unreachable + entry left in place", async () => {
    const store = new UploadStateStore()
    store.upsert(makeUpload())

    const http = {
      get: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    }

    const outcome = await reconcileOne(
      { apiBaseUrl: "https://example.com", authToken: "tok", store, http },
      makeUpload(),
    )

    expect(outcome.kind).toBe("unreachable")
    if (outcome.kind === "unreachable") {
      expect(outcome.error).toContain("ECONNREFUSED")
    }
    // Entry preserved — next reconcile pass will retry.
    expect(store.list()).toHaveLength(1)
  })

  test("4xx other than 404 → outcome is unreachable (preserve entry, surface error)", async () => {
    const store = new UploadStateStore()
    store.upsert(makeUpload())

    const http = {
      get: jest.fn().mockRejectedValue({
        response: { status: 401 },
        message: "Request failed with status code 401",
      }),
    }

    const outcome = await reconcileOne(
      { apiBaseUrl: "https://example.com", authToken: "tok", store, http },
      makeUpload(),
    )

    expect(outcome.kind).toBe("unreachable")
    expect(store.list()).toHaveLength(1)
  })
})
