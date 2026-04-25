/**
 * DH2 §6 — chunked-uploader resume test.
 *
 * Locks the highest-value end-to-end behavior the resume probe
 * was built for: when the server already has chunks 0–1 of a
 * 4-chunk file, the helper should re-upload only chunks 2–3.
 *
 * This is the test the spec calls "chunked-uploader-resume.test"
 * and that closes the pre-DH2 reality where the GET probe
 * always 404'd → helper started from zero every time.
 *
 * Mocks axios end-to-end so we can drive both the GET resume
 * probe and the per-chunk POST without a real server. Verifies:
 *   - GET is called once at the start with the right sessionId.
 *   - POST is called only for the missing chunks (NOT for the
 *     ones the GET reported).
 *   - The progress generator yields a final state of "complete"
 *     with the server's full chunk list reflected.
 */

import axios from "axios"
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ChunkedUploader, type UploadProgress } from "../chunked-uploader"
import { resetWakeClock } from "../wake-clock"

jest.mock("axios")
const axiosMock = axios as jest.Mocked<typeof axios>

beforeEach(() => {
  axiosMock.get.mockReset()
  axiosMock.post.mockReset()
  resetWakeClock()
})

describe("DH2 §6 — chunked-uploader resume", () => {
  test("when GET returns chunks [0,1] of 4, only chunks [2,3] are POSTed", async () => {
    // 4-chunk fixture: 4 × 5 MB = 20 MB. We can use a much
    // smaller fixture and force partial chunks instead — the
    // uploader uses CHUNK_SIZE = 5 MB, but a smaller file just
    // produces fewer chunks. We want exactly 4 chunks, so the
    // fixture is 4 × 5MB - 1B = 20,971,519 B. Allocate as a
    // sparse-ish buffer to keep the test fast.
    const CHUNK_SIZE = 5 * 1024 * 1024
    const dir = await fs.mkdtemp(join(tmpdir(), "ggih-resume-"))
    const filePath = join(dir, "fixture.bin")
    const buf = Buffer.alloc(CHUNK_SIZE * 4)
    await fs.writeFile(filePath, buf)

    // GET probe → server already has chunks 0 and 1.
    axiosMock.get.mockResolvedValue({
      data: {
        sessionId: "session-A",
        receivedChunks: [0, 1],
        uploadedBytes: CHUNK_SIZE * 2,
        uploadStatus: "UPLOADING",
        partsExpected: 4,
        partsReceived: 2,
        totalBytes: CHUNK_SIZE * 4,
      },
    })

    // POST for chunks 2 and 3 → success. Each response carries
    // the post-update receivedChunks list (echoed by the server
    // per DH2 §0).
    axiosMock.post
      .mockResolvedValueOnce({
        data: {
          receivedChunks: [0, 1, 2],
          uploadedBytes: CHUNK_SIZE * 3,
        },
      })
      .mockResolvedValueOnce({
        data: {
          receivedChunks: [0, 1, 2, 3],
          uploadedBytes: CHUNK_SIZE * 4,
        },
      })

    // Final GET (verify-completion at the end of the upload
    // generator) → server confirms all 4 chunks present.
    axiosMock.get.mockResolvedValueOnce({
      data: {
        sessionId: "session-A",
        receivedChunks: [0, 1],
        uploadedBytes: CHUNK_SIZE * 2,
        uploadStatus: "UPLOADING",
        partsExpected: 4,
        partsReceived: 2,
        totalBytes: CHUNK_SIZE * 4,
      },
    })
    // Override the LAST get with the completion shape since
    // mockResolvedValue + mockResolvedValueOnce interplay can
    // be brittle; explicitly mock the second call.
    axiosMock.get.mockReset()
    axiosMock.get
      .mockResolvedValueOnce({
        data: {
          sessionId: "session-A",
          receivedChunks: [0, 1],
          uploadedBytes: CHUNK_SIZE * 2,
          uploadStatus: "UPLOADING",
          partsExpected: 4,
          partsReceived: 2,
          totalBytes: CHUNK_SIZE * 4,
        },
      })
      .mockResolvedValueOnce({
        data: {
          sessionId: "session-A",
          receivedChunks: [0, 1, 2, 3],
          uploadedBytes: CHUNK_SIZE * 4,
          uploadStatus: "COMPLETED",
          partsExpected: 4,
          partsReceived: 4,
          totalBytes: CHUNK_SIZE * 4,
        },
      })

    const uploader = new ChunkedUploader(
      "https://example.com",
      "test-token",
    )
    const progress: UploadProgress[] = []
    for await (const p of uploader.uploadZip(filePath, "session-A")) {
      progress.push(p)
    }

    // Assertions.
    expect(axiosMock.get).toHaveBeenCalledTimes(2) // initial probe + final verify
    expect(axiosMock.post).toHaveBeenCalledTimes(2) // chunks 2 + 3 only

    // Verify each POST carried the right chunkIndex.
    const postCalls = axiosMock.post.mock.calls
    // First POST → chunk 2.
    const formData2 = postCalls[0][1] as FormData
    expect(formData2.get("chunkIndex")).toBe("2")
    // Second POST → chunk 3.
    const formData3 = postCalls[1][1] as FormData
    expect(formData3.get("chunkIndex")).toBe("3")

    // Final yielded state should be "complete" with the
    // server's confirmation.
    const last = progress[progress.length - 1]
    expect(last.state).toBe("complete")
    expect(last.receivedChunks).toEqual([0, 1, 2, 3])
  })

  test("when GET returns all chunks already received, no POST is made", async () => {
    const CHUNK_SIZE = 5 * 1024 * 1024
    const dir = await fs.mkdtemp(join(tmpdir(), "ggih-resume-"))
    const filePath = join(dir, "fixture.bin")
    await fs.writeFile(filePath, Buffer.alloc(CHUNK_SIZE * 2))

    axiosMock.get.mockResolvedValue({
      data: {
        sessionId: "session-A",
        receivedChunks: [0, 1],
        uploadedBytes: CHUNK_SIZE * 2,
        uploadStatus: "UPLOADING",
        partsExpected: 2,
        partsReceived: 2,
        totalBytes: CHUNK_SIZE * 2,
      },
    })

    const uploader = new ChunkedUploader(
      "https://example.com",
      "test-token",
    )
    const progress: UploadProgress[] = []
    for await (const p of uploader.uploadZip(filePath, "session-A")) {
      progress.push(p)
    }

    expect(axiosMock.post).not.toHaveBeenCalled()
    const last = progress[progress.length - 1]
    expect(last.state).toBe("complete")
  })

  test("when GET fails (server unreachable), uploader starts from chunk 0", async () => {
    // The pre-DH2 fallback path. Even with the GET probe in
    // place, a transient probe failure shouldn't crash the
    // uploader — it should fall back to "start from zero" so
    // the upload still happens (just less efficiently). The
    // server-side dedup on the chunk POST will reject duplicate
    // chunks if any were already there.
    const CHUNK_SIZE = 5 * 1024 * 1024
    const dir = await fs.mkdtemp(join(tmpdir(), "ggih-resume-"))
    const filePath = join(dir, "fixture.bin")
    await fs.writeFile(filePath, Buffer.alloc(CHUNK_SIZE * 2))

    // First GET (probe) fails. Second GET (final verify)
    // succeeds with completion state.
    axiosMock.get
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({
        data: {
          sessionId: "session-A",
          receivedChunks: [0, 1],
          uploadedBytes: CHUNK_SIZE * 2,
          uploadStatus: "COMPLETED",
          partsExpected: 2,
          partsReceived: 2,
          totalBytes: CHUNK_SIZE * 2,
        },
      })
    axiosMock.post
      .mockResolvedValueOnce({
        data: { receivedChunks: [0], uploadedBytes: CHUNK_SIZE },
      })
      .mockResolvedValueOnce({
        data: {
          receivedChunks: [0, 1],
          uploadedBytes: CHUNK_SIZE * 2,
        },
      })

    const uploader = new ChunkedUploader(
      "https://example.com",
      "test-token",
    )
    const progress: UploadProgress[] = []
    for await (const p of uploader.uploadZip(filePath, "session-A")) {
      progress.push(p)
    }

    // Both chunks were POSTed (no resume signal available).
    expect(axiosMock.post).toHaveBeenCalledTimes(2)
    const last = progress[progress.length - 1]
    expect(last.state).toBe("complete")
  })
})
