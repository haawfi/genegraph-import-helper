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
  .path { font-size: 11px; color: #999; margin-top: 12px; word-break: break-all; line-height: 1.3; }
</style></head><body>
  <div class="icon">${isMedium ? "&#x26A0;" : "&#x1F4E6;"}</div>
  <h2>${isMedium ? "Possible Takeout Archive Detected" : "Google Takeout Archive Detected"}</h2>
  <p class="subtitle">
    ${isMedium
      ? "A ZIP file that may be a Google Takeout export was found. Review the details below before uploading."
      : "A Google Takeout archive was detected in your watched folder."
    }
  </p>

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

  ${isMedium ? `
  <div class="warning">
    <strong>Lower confidence detection.</strong> This file has a Google Takeout directory structure
    but is missing the standard Takeout marker file. If you did not recently export data from
    Google Takeout, this may not be a Takeout archive.
  </div>
  ` : ""}

  ${isEmailTier ? `
  <div class="stepup-info">
    Large imports may require identity verification in the future.
    You can upgrade at any time from the GeneGraph dashboard.
  </div>
  ` : ""}

  <div class="actions">
    <button class="btn btn-reject" onclick="window.electronConfirmAPI.reject()">Not now</button>
    <button class="btn btn-approve" onclick="window.electronConfirmAPI.approve()">Upload to GeneGraph</button>
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
