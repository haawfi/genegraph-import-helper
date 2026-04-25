import { BrowserWindow, ipcMain } from "electron"
import path from "path"
import { TakeoutDetectionResult } from "./takeout-detector"

/**
 * UploadConfirmation
 *
 * Trust/safety control for detected archives. This is NOT an extra click —
 * it is a gate that:
 *
 *   1. Shows the user exactly what was detected (filename, size, confidence, reason)
 *   2. Explains what will happen if they approve (upload to GeneGraph account)
 *   3. Lets them inspect the archive path (not auto-trust)
 *   4. Provides a clear reject option that logs the decision
 *   5. Never auto-approves — the user must affirmatively consent each time
 *
 * Why this matters:
 *   - The watcher runs silently in the background. Users may not remember it's active.
 *   - A false positive (uploading a non-family ZIP) could leak sensitive data.
 *   - The user should know exactly what is being sent to the cloud before it happens.
 *   - Medium-confidence detections (no archive_browser.html) deserve extra scrutiny.
 *
 * Design principles:
 *   - Show, don't ask: present facts (filename, size, confidence), not just "Upload?"
 *   - Asymmetric labeling: approve button is specific ("Upload to GeneGraph"),
 *     reject button is safe default ("Not now")
 *   - Medium-confidence warning: explicit callout when detection is less certain
 *   - No dismiss-as-approve: closing the window = reject
 */

export interface ConfirmationRequest {
  archivePath: string
  filename: string
  fileSizeBytes: number
  confidence: "high" | "medium"
  reason: string
  partCount: number
  allParts: string[]
  /** User's verification tier — used for soft step-up messaging */
  verificationTier?: "email" | "identity" | "bank"
  /** DH2 §1 — full SHA-256 hex digest. Modal renders the first 8
   *  chars as a fingerprint string for user reassurance ("we
   *  know what we're about to upload"). Null on legacy callers
   *  that didn't compute a hash; the fingerprint affordance is
   *  hidden in that case. */
  archiveSha256?: string | null
  /** DH2 §4 — modal variant. Resolved by main.ts before opening
   *  the modal:
   *    - "first-time": default — no prior upload of this hash.
   *    - "resume": this hash matches a non-terminal session in
   *               the local upload-state-store. Modal copy
   *               offers Resume / Cancel.
   *    - "already-uploaded": this hash matches a COMPLETED
   *               session. Default button is Skip (the safe
   *               choice); secondary is Upload again. */
  variant?: "first-time" | "resume" | "already-uploaded"
  /** DH2 §4 — ISO timestamp of the prior upload start (resume
   *  variant) or completion (already-uploaded variant). Renders
   *  in the modal as "started/uploaded on [date]". */
  priorUploadAt?: string | null
}

export type ConfirmationResult = "approved" | "rejected" | "dismissed"

/**
 * Show the upload confirmation window and wait for user decision.
 * Returns a Promise that resolves when the user acts.
 */
export function showUploadConfirmation(
  request: ConfirmationRequest
): Promise<ConfirmationResult> {
  return new Promise((resolve) => {
    const confirmWindow = new BrowserWindow({
      width: 480,
      height: (request.confidence === "medium" ? 420 : 380) + ((!request.verificationTier || request.verificationTier === "email") ? 50 : 0),
      resizable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      title: "Archive Detected — GeneGraph",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "preload-confirm.js"),
      },
    })

    let resolved = false
    const finish = (result: ConfirmationResult) => {
      if (resolved) return
      resolved = true
      ipcMain.removeHandler("confirm:approve")
      ipcMain.removeHandler("confirm:reject")
      if (!confirmWindow.isDestroyed()) confirmWindow.close()
      resolve(result)
    }

    // IPC handlers for this confirmation (one-shot)
    ipcMain.handleOnce("confirm:approve", () => {
      console.log("[UploadConfirmation] User approved upload")
      finish("approved")
    })

    ipcMain.handleOnce("confirm:reject", () => {
      console.log("[UploadConfirmation] User rejected upload")
      finish("rejected")
    })

    // Window closed without explicit action = rejected (safe default)
    confirmWindow.on("closed", () => {
      finish("dismissed")
    })

    const html = buildConfirmationHTML(request)
    confirmWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  })
}

function buildConfirmationHTML(req: ConfirmationRequest): string {
  const sizeFormatted = formatBytes(req.fileSizeBytes)
  const isMultiPart = req.partCount > 1
  const isMedium = req.confidence === "medium"
  const isEmailTier = !req.verificationTier || req.verificationTier === "email"

  // DH2 §4 — variant-aware copy. Defaults to "first-time" so
  // legacy callers (no variant supplied) get the existing
  // pre-DH2 modal shape exactly.
  const variant = req.variant ?? "first-time"
  const isResume = variant === "resume"
  const isAlreadyUploaded = variant === "already-uploaded"
  const priorDate = req.priorUploadAt
    ? new Date(req.priorUploadAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null

  // Title + subtitle vary by variant. Icon stays the package
  // glyph except for "already-uploaded" which uses a checkmark
  // to visually distinguish the safe-default state.
  const headerIcon = isAlreadyUploaded ? "&#x2705;" : (isMedium ? "&#x26A0;" : "&#x1F4E6;")
  let title: string
  let subtitle: string
  if (isResume) {
    title = "Resume Upload?"
    subtitle = priorDate
      ? `We started uploading this archive on ${priorDate}. Resume from where we left off?`
      : "We started uploading this archive previously. Resume from where we left off?"
  } else if (isAlreadyUploaded) {
    title = "Already Uploaded"
    subtitle = priorDate
      ? `This archive was uploaded successfully on ${priorDate}. Upload again anyway?`
      : "This archive was uploaded successfully. Upload again anyway?"
  } else {
    title = isMedium ? "Possible Takeout Archive Detected" : "Google Takeout Archive Detected"
    subtitle = isMedium
      ? "A ZIP file that may be a Google Takeout export was found. Review the details below before uploading."
      : "A Google Takeout archive was detected in your watched folder."
  }

  // Button labels also vary. For the "already-uploaded" variant
  // the SAFE default is Skip — the spec is explicit about this:
  // "the default button should be 'Skip' not 'Upload again'."
  // We keep Approve/Reject button positions stable across
  // variants so users have spatial consistency.
  let rejectLabel = "Not now"
  let approveLabel = "Upload to GeneGraph"
  if (isResume) {
    rejectLabel = "Cancel"
    approveLabel = "Resume upload"
  } else if (isAlreadyUploaded) {
    // Approve = "Upload again" (override). Reject = "Skip"
    // (safe default). Visual emphasis remains on Approve via
    // the existing CSS, but the COPY makes Skip the right
    // choice.
    rejectLabel = "Skip — it's already in my vault"
    approveLabel = "Upload again"
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; padding: 24px; background: #fafafa; color: #1a1a1a; }
  .icon { font-size: 32px; margin-bottom: 12px; }
  h2 { font-size: 17px; font-weight: 600; margin-bottom: 6px; }
  .subtitle { font-size: 13px; color: #666; margin-bottom: 16px; line-height: 1.4; }
  .details { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; font-size: 13px; }
  .details .row { display: flex; justify-content: space-between; padding: 3px 0; }
  .details .label { color: #888; }
  .details .value { font-weight: 500; text-align: right; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .warning { background: #FFF8E1; border: 1px solid #FFE082; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; font-size: 12px; color: #6D4C00; line-height: 1.4; }
  .warning strong { color: #E65100; }
  .stepup-info { background: #E8F4FD; border: 1px solid #B3D9F2; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; font-size: 12px; color: #1565C0; line-height: 1.4; }
  .actions { display: flex; gap: 10px; }
  .btn { flex: 1; padding: 10px; border: none; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .btn-approve { background: #0096FF; color: white; }
  .btn-approve:hover { background: #007acc; }
  .btn-reject { background: #f0f0f0; color: #444; }
  .btn-reject:hover { background: #e0e0e0; }
  /* DH2 §4 — for the already-uploaded variant we visually
     elevate Skip (the safe default) by giving it the primary
     blue and demoting Upload-again to the muted gray, even
     though the IPC roles stay (Reject/Approve). */
  .btn-flip-approve { background: #f0f0f0; color: #444; }
  .btn-flip-approve:hover { background: #e0e0e0; }
  .btn-flip-reject { background: #0096FF; color: white; }
  .btn-flip-reject:hover { background: #007acc; }
  .path { font-size: 11px; color: #999; margin-top: 12px; word-break: break-all; line-height: 1.3; }
</style></head><body>
  <div class="icon">${headerIcon}</div>
  <h2>${escapeHtml(title)}</h2>
  <p class="subtitle">${escapeHtml(subtitle)}</p>

  <div class="details">
    <div class="row"><span class="label">File</span><span class="value" title="${escapeHtml(req.filename)}">${escapeHtml(req.filename)}</span></div>
    <div class="row"><span class="label">Size</span><span class="value">${sizeFormatted}</span></div>
    ${isMultiPart ? `<div class="row"><span class="label">Parts</span><span class="value">${req.partCount} archive parts</span></div>` : ""}
    <div class="row"><span class="label">Confidence</span><span class="value">${req.confidence === "high" ? "High" : "Medium"}</span></div>
    ${
      req.archiveSha256
        ? `<div class="row"><span class="label">Fingerprint</span><span class="value" title="${escapeHtml(req.archiveSha256)}" style="font-family: ui-monospace, monospace;">${escapeHtml(req.archiveSha256.slice(0, 8))}</span></div>`
        : ""
    }
  </div>

  ${isMedium && variant === "first-time" ? `
  <div class="warning">
    <strong>Lower confidence detection.</strong> This file has a Google Takeout directory structure
    but is missing the standard Takeout marker file. If you did not recently export data from
    Google Takeout, this may not be a Takeout archive.
  </div>
  ` : ""}

  ${isEmailTier && variant === "first-time" ? `
  <div class="stepup-info">
    Large imports may require identity verification in the future.
    You can upgrade at any time from the GeneGraph dashboard.
  </div>
  ` : ""}

  <div class="actions">
    <button class="btn ${isAlreadyUploaded ? "btn-flip-reject" : "btn-reject"}" onclick="window.electronConfirmAPI.reject()">${escapeHtml(rejectLabel)}</button>
    <button class="btn ${isAlreadyUploaded ? "btn-flip-approve" : "btn-approve"}" onclick="window.electronConfirmAPI.approve()">${escapeHtml(approveLabel)}</button>
  </div>

  <p class="path">${escapeHtml(req.archivePath)}</p>
</body></html>`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
