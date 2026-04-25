/**
 * DH2 §4 — error classification.
 *
 * Locks the {status code → category} mapping so retries don't
 * burn the budget on permanent failures and auth-fail surfaces
 * trigger a re-login flow instead of three pointless chunk
 * POSTs.
 */

import {
  classifyError,
  permanentFailMessage,
  type UploadErrorCategory,
} from "../error-classification"

function err(status: number | undefined): { response?: { status: number } } {
  return status === undefined ? {} : { response: { status } }
}

describe("DH2 §4 — classifyError", () => {
  test("network error (no HTTP response) → transient", () => {
    expect(classifyError(new Error("ECONNREFUSED"))).toBe("transient")
    expect(classifyError({})).toBe("transient")
  })

  test("401 → auth-fail", () => {
    expect(classifyError(err(401))).toBe("auth-fail")
  })

  test("410 / 413 / 422 → permanent-fail", () => {
    const cases: Array<[number, UploadErrorCategory]> = [
      [410, "permanent-fail"],
      [413, "permanent-fail"],
      [422, "permanent-fail"],
    ]
    for (const [status, expected] of cases) {
      expect(classifyError(err(status))).toBe(expected)
    }
  })

  test("other 4xx → permanent-fail (won't fix itself on retry)", () => {
    expect(classifyError(err(400))).toBe("permanent-fail")
    expect(classifyError(err(403))).toBe("permanent-fail")
    expect(classifyError(err(404))).toBe("permanent-fail")
    expect(classifyError(err(429))).toBe("permanent-fail")
  })

  test("5xx → retry (server-side issue may resolve)", () => {
    expect(classifyError(err(500))).toBe("retry")
    expect(classifyError(err(502))).toBe("retry")
    expect(classifyError(err(503))).toBe("retry")
    expect(classifyError(err(504))).toBe("retry")
  })

  test("unexpected status (sub-400) → retry as a safe default", () => {
    expect(classifyError(err(200))).toBe("retry")
    expect(classifyError(err(304))).toBe("retry")
  })

  test("non-Error / non-axios input doesn't crash", () => {
    expect(classifyError(null)).toBe("transient")
    expect(classifyError(undefined)).toBe("transient")
    expect(classifyError("plain string")).toBe("transient")
  })
})

describe("DH2 §4 — permanentFailMessage", () => {
  test("410 surfaces session-expired copy", () => {
    expect(permanentFailMessage(410)).toMatch(/expired/i)
  })

  test("413 surfaces too-large copy", () => {
    expect(permanentFailMessage(413)).toMatch(/too large/i)
  })

  test("422 surfaces invalid-format copy", () => {
    expect(permanentFailMessage(422)).toMatch(/invalid format/i)
  })

  test("403 surfaces device-deregistered copy", () => {
    expect(permanentFailMessage(403)).toMatch(/no longer registered/i)
  })

  test("unknown status falls back to a generic message", () => {
    expect(permanentFailMessage(418)).toMatch(/HTTP 418/)
    expect(permanentFailMessage(undefined)).toMatch(/unknown/)
  })
})
