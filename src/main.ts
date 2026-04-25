import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  dialog,
  Notification,
} from "electron"
import path from "path"
import os from "os"
import { shell } from "electron"
import { autoUpdater } from "electron-updater"
import { AuthManager, VerificationTier } from "./auth-manager"
import { FolderWatcher } from "./folder-watcher"
import { TakeoutDetector } from "./takeout-detector"
import { MultiPartCollector } from "./multi-part-collector"
import { ChunkedUploader } from "./chunked-uploader"
import { NotificationManager } from "./notification-manager"
import { SettingsStore } from "./settings-store"
import { showUploadConfirmation, ConfirmationRequest } from "./upload-confirmation"
import { hashArchive } from "./archive-hash"
import { UploadStateStore, type ActiveUpload } from "./upload-state-store"
import { reconcileOnStartup, type ReconcileOutcome } from "./startup-reconciler"

/**
 * GeneGraph Import Helper
 *
 * Electron app that:
 * 1. Watches Downloads folder for Google Takeout archives
 * 2. Detects multi-part archives and waits for all parts
 * 3. Uploads to the GeneGraph API with progress tracking
 * 4. Manages authentication via system keychain
 * 5. Runs in system tray with context menu
 * 6. Persists settings across restarts
 *
 * NOTE on internal naming (DH1): user-visible strings render as
 * "GeneGraph Import Helper", but the on-disk identifiers
 * (`appId: com.genegraph.famvault.desktop-helper`, package name
 * `famvault-desktop-helper`, keychain `SERVICE_NAME` in
 * auth-manager.ts, the `com.genegraph.famvault.desktop-helper`
 * keychain access group in `build/entitlements.mac.plist`) stay
 * as-is. Changing them would invalidate existing alpha-tester
 * tokens and stored settings; a future v2.0 reconciliation can
 * tidy up if/when it matters.
 */

interface AppState {
  isWatching: boolean
  uploadInProgress: boolean
  isAuthenticated: boolean
  userEmail: string | null
  verificationTier: VerificationTier
}

let tray: Tray | null = null
let settings: SettingsStore
let appState: AppState = {
  isWatching: false,
  uploadInProgress: false,
  isAuthenticated: false,
  userEmail: null,
  verificationTier: "email",
}

let folderWatcher: FolderWatcher | null = null
let multiPartCollector: MultiPartCollector | null = null
let authManager: AuthManager | null = null
let notificationManager: NotificationManager | null = null
let loginWindow: BrowserWindow | null = null
// DH2 §2 — persistent upload-state store. Created during
// initializeApp() so the store is available before any code path
// can mutate it. Survives crash + restart; corrupted files start
// fresh with a logged warning.
let uploadStateStore: UploadStateStore | null = null
// DH2 §2 — outcomes from the most recent reconcile pass. The
// tray menu (DH2 §5) reads from this list; user clicks "Resume"
// or "Cancel" against entries here.
let reconcileOutcomes: ReconcileOutcome[] = []

/**
 * Initialize app
 */
async function initializeApp() {
  settings = new SettingsStore()

  // Default watch path to Downloads if not set
  if (!settings.get("watchPath")) {
    settings.set("watchPath", path.join(os.homedir(), "Downloads"))
  }

  const apiBaseUrl = settings.get("apiBaseUrl")
  authManager = new AuthManager(apiBaseUrl)
  notificationManager = new NotificationManager()
  // DH2 §2 — load the persisted upload-state store. Created here
  // so it's available before any reconciler / upload path can
  // touch it.
  uploadStateStore = new UploadStateStore()

  // Restore auto-start setting
  try {
    app.setLoginItemSettings({
      openAtLogin: settings.get("autoStartEnabled"),
    })
  } catch (err) {
    console.warn("[App] Failed to set login item:", err)
  }

  // Check if user is already authenticated
  try {
    appState.isAuthenticated = await authManager.isAuthenticated()
    if (appState.isAuthenticated) {
      appState.userEmail = await authManager.getUserEmail()
      appState.verificationTier = await authManager.getVerificationTier()
    }
  } catch (authErr) {
    console.error("[App] Auth check failed:", authErr)
    appState.isAuthenticated = false
  }

  createTray()
  setupIpcHandlers()
  setupGracefulShutdown()

  // DH2 §2 — startup reconciliation. Only runs when authenticated;
  // unauthenticated users have no useful server queries to make.
  // Surfaces outcomes via notifications + the tray menu (DH2 §5
  // adds the menu section) — never auto-resumes per the spec
  // ("the user clicked away — they may have done so deliberately").
  if (appState.isAuthenticated && uploadStateStore.list().length > 0) {
    await runStartupReconcile()
  }
}

/**
 * DH2 §2 — runs the reconciler against the current upload-state
 * store and surfaces outcomes to the user. Intentionally
 * non-blocking on failure: a network hiccup at startup leaves
 * entries in the "unreachable" bucket, which the user can retry
 * via the tray menu's Reconcile action (DH2 §5) or the next
 * reconcile cycle (post-wake handler in §3 calls this too).
 */
async function runStartupReconcile(): Promise<void> {
  if (!uploadStateStore || !authManager) return
  const apiBaseUrl = settings.get("apiBaseUrl")
  const authToken = await authManager.getToken()
  if (!authToken) {
    console.warn("[Reconcile] No auth token; skipping reconciliation.")
    return
  }
  try {
    reconcileOutcomes = await reconcileOnStartup({
      apiBaseUrl,
      authToken,
      store: uploadStateStore,
    })
    for (const outcome of reconcileOutcomes) {
      switch (outcome.kind) {
        case "completed":
          notificationManager?.showUploadComplete(
            path.basename(outcome.entry.archivePath),
            0,
          )
          console.log(
            `[Reconcile] Server completed ${outcome.sessionId} in our absence; cleared local state.`,
          )
          break
        case "resumable":
          // Surface a notification — full UI affordance is in DH2
          // §5 (tray menu). The user picks Resume or Cancel from
          // the tray; we don't auto-resume.
          notificationManager?.showDetection(
            `Resumable upload: ${path.basename(outcome.entry.archivePath)} (${outcome.partsReceived}/${outcome.entry.partsExpected} parts on server)`,
          )
          console.log(
            `[Reconcile] Resumable session ${outcome.sessionId}; waiting for user action.`,
          )
          break
        case "expired":
          notificationManager?.showDetection(
            `Previous upload expired: ${path.basename(outcome.entry.archivePath)}. Re-detect to retry.`,
          )
          console.log(
            `[Reconcile] Session ${outcome.sessionId} expired; cleared local state.`,
          )
          break
        case "unreachable":
          console.warn(
            `[Reconcile] Couldn't reach server for ${outcome.sessionId}: ${outcome.error}. Will retry on next pass.`,
          )
          break
      }
    }
    updateTrayMenu()
  } catch (err) {
    console.error("[Reconcile] Failed:", err)
  }
}

/**
 * Create system tray icon and menu
 */
function createTray() {
  // Use macOS template icon — "Template" suffix tells macOS to auto-handle
  // dark/light mode. The icon is black-on-transparent; macOS inverts for dark.
  const iconPath = path.join(__dirname, "..", "assets", "iconTemplate.png")

  try {
    const { nativeImage } = require("electron")
    const img = nativeImage.createFromPath(iconPath)
    // Mark as template so macOS handles dark/light mode automatically
    img.setTemplateImage(true)
    tray = new Tray(img)
    tray.setToolTip("GeneGraph Import Helper")
    updateTrayMenu()
  } catch (err) {
    console.error("[Tray] Failed to create tray:", err)
  }
}

/**
 * Update tray menu to reflect current state
 */
function updateTrayMenu() {
  if (!tray) return

  const watchPath = settings.get("watchPath")
  const recentUploads = settings.get("recentUploads")

  const statusLabel = appState.isAuthenticated
    ? appState.userEmail
      ? `Signed in as ${appState.userEmail}`
      : "Signed in"
    : "Not signed in"

  // Verification tier display
  const tierLabels: Record<VerificationTier, string> = {
    email: "✉ Email verified",
    identity: "✓ Identity verified",
    bank: "🛡 Bank verified",
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: statusLabel,
      enabled: false,
    },
    // Show verification tier when authenticated
    ...(appState.isAuthenticated
      ? [
          {
            label: tierLabels[appState.verificationTier],
            enabled: false,
          },
        ]
      : []),
    {
      label: appState.isWatching
        ? `Watching: ${path.basename(watchPath)}`
        : "Not watching",
      enabled: false,
    },
    { type: "separator" },
    // Upgrade CTA for email-only users (subtle, non-blocking)
    ...(appState.isAuthenticated && appState.verificationTier === "email"
      ? [
          {
            label: "Upgrade verification →",
            click: () => {
              const baseUrl = authManager?.getBaseUrl() || "https://genegraph.eu"
              shell.openExternal(`${baseUrl}/dashboard`)
            },
          },
          { type: "separator" as const },
        ]
      : []),
    {
      label: appState.isWatching ? "Stop Watching" : "Start Watching",
      click: () => toggleWatching(),
      enabled: appState.isAuthenticated,
    },
    {
      label: "Watch Folder...",
      click: () => selectWatchFolder(),
    },
    {
      label: "Recent Uploads",
      submenu:
        recentUploads.length > 0
          ? recentUploads.map((upload) => ({
              label: upload,
              enabled: false,
            }))
          : [{ label: "No recent uploads", enabled: false }],
    },
    { type: "separator" },
    {
      label: "Start at login",
      type: "checkbox",
      checked: settings.get("autoStartEnabled"),
      click: () => toggleAutoStart(),
    },
    {
      label: appState.isAuthenticated ? "Sign out" : "Sign in...",
      click: () => {
        if (appState.isAuthenticated) {
          logout()
        } else {
          showLoginWindow()
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ])

  tray.setContextMenu(contextMenu)
}

/**
 * Show login window (email OTP flow)
 */
function showLoginWindow() {
  if (loginWindow) {
    loginWindow.focus()
    return
  }

  loginWindow = new BrowserWindow({
    width: 400,
    height: 340,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Sign in to GeneGraph",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  })

  // Load inline HTML for the login form
  loginWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getLoginHTML())}`)

  loginWindow.on("closed", () => {
    loginWindow = null
  })
}

/**
 * Get login form HTML (self-contained, no external deps)
 */
function getLoginHTML(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; background: #fafafa; color: #1a1a1a; }
  h2 { font-size: 18px; margin: 0 0 4px; } p { font-size: 13px; color: #666; margin: 0 0 20px; }
  label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 4px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; margin-bottom: 12px; }
  input:focus { outline: none; border-color: #0096FF; box-shadow: 0 0 0 3px rgba(0,150,255,0.1); }
  button { width: 100%; padding: 10px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; background: #0096FF; color: white; }
  button:hover { background: #007acc; } button:disabled { background: #ccc; cursor: default; }
  .error { color: #dc3545; font-size: 12px; margin-bottom: 8px; display: none; }
  .step { display: none; } .step.active { display: block; }
  #success { text-align: center; padding-top: 40px; }
  #success .check { font-size: 48px; margin-bottom: 12px; }
</style></head><body>
  <div id="step1" class="step active">
    <h2>Sign in to GeneGraph</h2>
    <p>Enter your email to receive a sign-in code.</p>
    <label for="email">Email</label>
    <input type="email" id="email" placeholder="you@example.com" autofocus>
    <div class="error" id="err1"></div>
    <button id="btn1" onclick="sendOTP()">Send code</button>
  </div>
  <div id="step2" class="step">
    <h2>Enter your code</h2>
    <p id="sentTo"></p>
    <label for="otp">6-digit code</label>
    <input type="text" id="otp" maxlength="6" pattern="[0-9]*" inputmode="numeric" autofocus>
    <div class="error" id="err2"></div>
    <button id="btn2" onclick="verifyOTP()">Sign in</button>
  </div>
  <div id="success" class="step">
    <div class="check">&#x2705;</div>
    <h2>Signed in!</h2>
    <p>You can close this window.</p>
  </div>
<script>
  const { ipcRenderer } = window.electronAPI || {};

  async function sendOTP() {
    const email = document.getElementById('email').value.trim();
    if (!email) return;
    document.getElementById('btn1').disabled = true;
    document.getElementById('err1').style.display = 'none';
    try {
      const result = await window.electronAPI.sendOTP(email);
      if (result.success) {
        document.getElementById('sentTo').textContent = 'Code sent to ' + email;
        document.getElementById('step1').classList.remove('active');
        document.getElementById('step2').classList.add('active');
        document.getElementById('otp').focus();
      } else {
        document.getElementById('err1').textContent = result.error;
        document.getElementById('err1').style.display = 'block';
      }
    } catch(e) { document.getElementById('err1').textContent = e.message; document.getElementById('err1').style.display = 'block'; }
    document.getElementById('btn1').disabled = false;
  }

  async function verifyOTP() {
    const email = document.getElementById('email').value.trim();
    const otp = document.getElementById('otp').value.trim();
    if (!otp || otp.length !== 6) return;
    document.getElementById('btn2').disabled = true;
    document.getElementById('err2').style.display = 'none';
    try {
      const result = await window.electronAPI.verifyOTP(email, otp);
      if (result.success) {
        document.getElementById('step2').classList.remove('active');
        document.getElementById('success').classList.add('active');
        setTimeout(() => window.close(), 2000);
      } else {
        document.getElementById('err2').textContent = result.error;
        document.getElementById('err2').style.display = 'block';
      }
    } catch(e) { document.getElementById('err2').textContent = e.message; document.getElementById('err2').style.display = 'block'; }
    document.getElementById('btn2').disabled = false;
  }

  document.getElementById('email').addEventListener('keydown', e => { if (e.key === 'Enter') sendOTP(); });
  document.getElementById('otp').addEventListener('keydown', e => { if (e.key === 'Enter') verifyOTP(); });
</script></body></html>`
}

/**
 * Toggle folder watching
 */
async function toggleWatching() {
  if (appState.isWatching) {
    stopWatching()
  } else {
    startWatching()
  }
}

/**
 * Start watching folder
 */
async function startWatching() {
  if (!appState.isAuthenticated) {
    notificationManager?.showError("Please sign in before watching for uploads")
    return
  }

  if (appState.isWatching) return

  try {
    if (!authManager) throw new Error("Auth manager not initialized")

    const authToken = await authManager.getToken()
    if (!authToken) throw new Error("No auth token available")

    const watchPath = settings.get("watchPath")

    // Initialize multi-part collector
    multiPartCollector = new MultiPartCollector()

    multiPartCollector.on("all-parts-ready", async (archivePath, metadata) => {
      await confirmAndUpload(authToken, archivePath, metadata)
    })

    multiPartCollector.on("timeout", async (archivePath, metadata) => {
      console.warn(`Timeout waiting for parts, proceeding with available`)
      await confirmAndUpload(authToken, archivePath, metadata)
    })

    // Start folder watcher
    folderWatcher = new FolderWatcher(watchPath)

    folderWatcher.on("new-zip", async (filePath) => {
      const basename = path.basename(filePath)
      console.log(`[Watcher] ZIP detected: ${basename}`)

      const detector = new TakeoutDetector()
      const takeoutInfo = await detector.detect(filePath)

      if (takeoutInfo.isTakeout) {
        console.log(`[Watcher] Takeout detected (${takeoutInfo.confidence}): ${basename}`)
        // Notification is informational only — confirmation gate happens before upload
        notificationManager?.showDetection(basename)
        if (multiPartCollector) {
          multiPartCollector.addPart(filePath, takeoutInfo)
        }
      } else {
        console.log(`[Watcher] Not a Takeout archive: ${basename} — ${takeoutInfo.reason}`)
      }
    })

    appState.isWatching = true
    notificationManager?.showDetection("Watching for Takeout archives")
    updateTrayMenu()
  } catch (error) {
    console.error("Error starting watcher:", error)
    notificationManager?.showError(
      `Failed to start watching: ${error instanceof Error ? error.message : "Unknown error"}`
    )
  }
}

/**
 * Stop watching folder
 */
function stopWatching() {
  if (folderWatcher) {
    folderWatcher.stop()
    folderWatcher = null
  }

  if (multiPartCollector) {
    multiPartCollector.stop()
    multiPartCollector = null
  }

  appState.isWatching = false
  updateTrayMenu()
}

/**
 * Trust/safety gate: show confirmation window, then upload if approved.
 *
 * This is the primary safety control for the background watcher.
 * The user sees exactly what was detected and must affirmatively approve.
 * Closing the window or clicking "Not now" = no upload.
 */
async function confirmAndUpload(
  authToken: string,
  archivePath: string,
  metadata: any
) {
  const filename = path.basename(archivePath)
  const confidence = metadata.confidence || "high"

  // ── DH2 §1: streaming SHA-256 hash before the modal ──────────────
  // Computed once after the watcher confirms the archive is stable.
  // Surfaced to the user as an 8-char fingerprint in the modal so
  // they can recognize that we know what we're about to upload.
  // Server uses the full hex digest for the dedup query at session-
  // create time. Failures here are non-fatal — fall through to a
  // null hash, which makes the server skip the dedup short-circuit
  // and behave exactly as pre-DH2 (always create new session).
  let archiveSha256: string | null = null
  try {
    archiveSha256 = await hashArchive(archivePath)
    console.log(
      `[Upload] Archive hash for ${filename}: ${archiveSha256.slice(0, 12)}…`,
    )
  } catch (err) {
    console.warn(
      `[Upload] Failed to hash ${filename}; will create a new session without dedup:`,
      err,
    )
  }

  // ── Safety gate: user confirmation ────────────────────────────────
  const confirmRequest: ConfirmationRequest = {
    archivePath,
    filename,
    fileSizeBytes: metadata.fileSizeBytes || 0,
    confidence,
    reason: metadata.reason || "Google Takeout archive detected",
    partCount: metadata.totalParts || 1,
    allParts: metadata.allPartsFound || [archivePath],
    verificationTier: appState.verificationTier,
    archiveSha256,
  }

  const decision = await showUploadConfirmation(confirmRequest)

  if (decision !== "approved") {
    console.log(`[Upload] User ${decision} upload of ${filename}`)
    notificationManager?.showDetection(
      decision === "rejected"
        ? `Skipped: ${filename}`
        : `Dismissed: ${filename}`
    )
    return
  }

  // ── User approved — proceed with upload ───────────────────────────
  console.log(`[Upload] User approved upload of ${filename}`)
  // Plumb the hash through `metadata` so executeSingleUpload can
  // include it in the session-create POST without changing the
  // function's existing signature.
  await executeUpload(authToken, archivePath, {
    ...metadata,
    archiveSha256,
  })
}

// ─── Upload Queue ──────────────────────────────────────────────────────────
// Archives are queued and processed one at a time. The user sees each one
// move through the pipeline: queued → connectivity check → creating session →
// uploading (chunk N/M) → complete/failed.

interface QueuedUpload {
  authToken: string
  archivePath: string
  metadata: any
}

const uploadQueue: QueuedUpload[] = []
let processingQueue = false

/**
 * Add an approved upload to the queue and start processing if idle.
 */
async function executeUpload(
  authToken: string,
  archivePath: string,
  metadata: any
) {
  uploadQueue.push({ authToken, archivePath, metadata })
  console.log(
    `[Upload] Queued: ${path.basename(archivePath)} (${uploadQueue.length} in queue)`
  )

  if (!processingQueue) {
    processUploadQueue()
  }
}

/**
 * Process queued uploads one at a time.
 */
async function processUploadQueue() {
  if (processingQueue) return
  processingQueue = true

  while (uploadQueue.length > 0) {
    const item = uploadQueue.shift()!
    await executeSingleUpload(item.authToken, item.archivePath, item.metadata)
  }

  processingQueue = false
}

/**
 * Execute a single upload with connectivity check, server-confirmed progress,
 * and honest status reporting.
 */
async function executeSingleUpload(
  authToken: string,
  archivePath: string,
  metadata: any
) {
  const filename = path.basename(archivePath)
  const apiBaseUrl = settings.get("apiBaseUrl")

  appState.uploadInProgress = true
  updateTrayMenu()

  try {
    // ── Connectivity check ──────────────────────────────────────────
    const uploader = new ChunkedUploader(apiBaseUrl, authToken)
    const online = await uploader.checkConnectivity()
    if (!online) {
      notificationManager?.showError(
        `Cannot reach server. Upload of ${filename} will retry when connected.`
      )
      // Re-queue for later
      uploadQueue.push({ authToken, archivePath, metadata })
      // Wait 30s before retrying the queue
      await new Promise((r) => setTimeout(r, 30_000))
      return
    }

    // ── Create upload session ───────────────────────────────────────
    // DH2 §1 — body carries the optional archiveSha256 hash. Server
    // uses it to short-circuit re-uploads:
    //   - If the same hash is COMPLETED for this user, the response
    //     is `{ deduplicated: true, ... }` and we skip the upload.
    //   - If it matches a non-terminal session, the response carries
    //     `{ resuming: true, session: { ... } }` and we resume that
    //     session id instead of creating a new one.
    //   - If it doesn't match (or no hash supplied), normal create.
    const deviceId = authManager?.["deviceInfo"]?.deviceId || `${os.hostname()}-${process.platform}`
    const sessionResponse = await fetch(
      `${apiBaseUrl}/api/import/desktop/upload`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          deviceId,
          zipFilename: filename,
          partsExpected: metadata.totalParts || 1,
          totalBytes: metadata.fileSizeBytes || metadata.totalBytes || 0,
          // Conditional spread: omit the field entirely when null
          // so legacy / hash-less callers keep their pre-DH2 wire
          // shape and pass through any future strict-validation
          // middleware that rejects unknown fields.
          ...(metadata.archiveSha256
            ? { archiveSha256: metadata.archiveSha256 }
            : {}),
        }),
      }
    )

    if (!sessionResponse.ok) {
      throw new Error(`Failed to create upload session: ${sessionResponse.statusText}`)
    }

    const sessionData = (await sessionResponse.json()) as
      | { deduplicated: true; existingSessionId: string; completedAt: number; zipFilename: string }
      | { deduplicated?: false; resuming?: boolean; session: { id: string } }

    // DH2 §1 — handle the dedup short-circuit. The "already
    // uploaded" branch lights a notification and exits; the
    // confirmation modal's "already-uploaded" variant in step 4
    // catches this case before we ever land in executeSingleUpload.
    // Reaching here means the user explicitly opted to override —
    // in v1 we still skip (to avoid double-uploading the same
    // archive) and surface the existing completion. Override-and-
    // re-upload requires a separate user gesture handled in step 4.
    if ("deduplicated" in sessionData && sessionData.deduplicated === true) {
      console.log(
        `[Upload] Server reports ${filename} already uploaded; skipping. Existing session: ${sessionData.existingSessionId}`,
      )
      notificationManager?.showDetection(
        `Already uploaded: ${filename}`,
      )
      return
    }

    const sessionId = sessionData.session.id
    if (sessionData.resuming) {
      console.log(
        `[Upload] Resuming existing non-terminal session ${sessionId} for ${filename}`,
      )
    }

    // DH2 §2 — record the in-progress upload in the persistent
    // store BEFORE the first chunk POST. If the helper crashes
    // mid-upload, this entry survives and the next launch's
    // reconciler will surface a Resume affordance to the user.
    if (uploadStateStore && metadata.archiveSha256) {
      const totalBytes = metadata.fileSizeBytes || metadata.totalBytes || 0
      const partsExpected = metadata.totalParts || Math.ceil(totalBytes / (5 * 1024 * 1024)) || 1
      const upload: ActiveUpload = {
        sessionId,
        archivePath,
        archiveSha256: metadata.archiveSha256,
        totalBytes,
        partsExpected,
        lastConfirmedChunk: -1,
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        status: "uploading",
      }
      uploadStateStore.upsert(upload)
    }

    // ── Upload with server-confirmed progress ───────────────────────
    let lastNotifiedPercent = -1
    let uploadSucceeded = false

    for await (const progress of uploader.uploadZip(archivePath, sessionId)) {
      // Show every state honestly
      switch (progress.state) {
        case "querying_server":
          // Silent — brief operation
          break

        case "uploading": {
          // Only notify at 10% intervals (server-confirmed progress)
          const percent = progress.progress
          if (percent >= lastNotifiedPercent + 10 || percent === 100) {
            notificationManager?.showUploadProgress(filename, percent)
            lastNotifiedPercent = percent
          }
          // DH2 §2 — persist the highest server-confirmed chunk
          // index after every advance so a crash leaves a useful
          // resume pointer.
          if (uploadStateStore) {
            uploadStateStore.recordChunkConfirmed(
              sessionId,
              progress.currentChunk,
            )
          }
          break
        }

        case "complete":
          uploadSucceeded = true
          break

        case "failed":
          notificationManager?.showError(
            `Upload failed: ${progress.errorMessage || "Unknown error"}\n${progress.statusMessage}`
          )
          // DH2 §2 — mark failed in the persistent store so the
          // next-launch reconciler surfaces it as a "previous
          // upload failed" affordance rather than a stale
          // "uploading" entry.
          if (uploadStateStore) {
            uploadStateStore.markFailed(
              sessionId,
              progress.errorMessage || "Unknown error",
            )
          }
          break
      }
    }

    if (uploadSucceeded) {
      // DH2 §2 — clear the persisted entry on completion. Failed
      // entries are kept (above) so the user can see the failure
      // reason on next startup.
      if (uploadStateStore) {
        uploadStateStore.remove(sessionId)
      }
      // Add to recent uploads (persisted)
      const recent = settings.get("recentUploads")
      recent.unshift(filename)
      if (recent.length > 5) recent.pop()
      settings.set("recentUploads", recent)

      notificationManager?.showUploadComplete(filename, metadata.estimatedFiles || 0)
    }

    updateTrayMenu()
  } catch (error) {
    console.error("[Upload] Error:", error)
    notificationManager?.showError(
      `Upload failed: ${error instanceof Error ? error.message : "Unknown error"}`
    )
  } finally {
    appState.uploadInProgress = uploadQueue.length > 0
    updateTrayMenu()
  }
}

/**
 * Select folder to watch
 */
async function selectWatchFolder() {
  const result = await dialog.showOpenDialog({
    defaultPath: settings.get("watchPath"),
    properties: ["openDirectory"],
  })

  if (!result.canceled && result.filePaths.length > 0) {
    settings.set("watchPath", result.filePaths[0])

    if (appState.isWatching) {
      stopWatching()
      startWatching()
    }

    updateTrayMenu()
  }
}

/**
 * Toggle auto-start
 */
function toggleAutoStart() {
  const newValue = !settings.get("autoStartEnabled")
  settings.set("autoStartEnabled", newValue)
  app.setLoginItemSettings({ openAtLogin: newValue })
  updateTrayMenu()
}

/**
 * Logout
 */
async function logout() {
  try {
    if (authManager) {
      await authManager.logout()
    }
    appState.isAuthenticated = false
    appState.userEmail = null
    appState.verificationTier = "email"
    stopWatching()
    updateTrayMenu()
    notificationManager?.showDetection("Signed out")
  } catch (error) {
    console.error("Logout error:", error)
    notificationManager?.showError("Sign out failed")
  }
}

/**
 * Setup IPC handlers for renderer (login window) communication
 */
function setupIpcHandlers() {
  ipcMain.handle("auth:send-otp", async (_event, email: string) => {
    if (!authManager) return { success: false, error: "Not initialized" }
    return authManager.requestOTP(email)
  })

  ipcMain.handle("auth:verify-otp", async (_event, email: string, otp: string) => {
    if (!authManager) return { success: false, error: "Not initialized" }
    const result = await authManager.verifyOTP(email, otp)
    if (result.success) {
      appState.isAuthenticated = true
      appState.userEmail = email
      appState.verificationTier = await authManager.getVerificationTier()
      updateTrayMenu()
      // Close login window after brief delay
      if (loginWindow) {
        setTimeout(() => { loginWindow?.close() }, 2000)
      }
    }
    return result
  })

  ipcMain.handle("app:get-state", () => appState)
  ipcMain.handle("app:get-status", () => ({
    isWatching: appState.isWatching,
    isAuthenticated: appState.isAuthenticated,
    uploadInProgress: appState.uploadInProgress,
    watchPath: settings.get("watchPath"),
    userEmail: appState.userEmail,
    verificationTier: appState.verificationTier,
  }))
}

/**
 * Setup graceful shutdown handlers
 */
function setupGracefulShutdown() {
  app.on("before-quit", async (event) => {
    console.log("[App] Shutting down gracefully...")

    // Stop folder watcher
    if (folderWatcher) {
      folderWatcher.stop()
      folderWatcher = null
    }

    // Stop multi-part collector (clears timeouts)
    if (multiPartCollector) {
      multiPartCollector.stop()
      multiPartCollector = null
    }

    // Clean up auth manager timers
    if (authManager) {
      authManager.destroy()
    }

    // Close login window if open
    if (loginWindow) {
      loginWindow.close()
      loginWindow = null
    }

    console.log("[App] Shutdown complete")
  })
}

/**
 * Electron app lifecycle
 */
app.on("ready", async () => {
  await initializeApp()
  // Hide dock icon — this is a tray-only app. Called AFTER initializeApp()
  // so the tray is already created (otherwise macOS may treat it as a
  // background app with no UI and silently exit).
  app.dock?.hide()

  // DH1 §5 — auto-update against the publish target
  // (haawfi/genegraph-import-helper, configured in
  // package.json#build.publish). The default
  // `checkForUpdatesAndNotify()` behaviour is good enough for v1:
  // updates download in the background, then prompt the user to
  // relaunch when ready. No custom UI in DH1; that's later polish.
  //
  // Skip in dev (when packaged === false) — electron-updater would
  // otherwise log noisy "no app-update.yml" errors against the
  // unpacked tsc output. The packaged app reads the YAML that
  // electron-builder writes alongside the binaries.
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error("[autoUpdate] initial check failed:", err)
    })
    // Re-check every 4 hours while the app is running. Helper is
    // a tray-only long-lived process; users may leave it running
    // for days. Polling at this cadence catches new releases
    // without hammering GitHub.
    setInterval(
      () => {
        autoUpdater.checkForUpdatesAndNotify().catch((err) => {
          console.error("[autoUpdate] periodic check failed:", err)
        })
      },
      4 * 60 * 60 * 1000,
    )
  }
})

// DH1 §5 — surface auto-updater errors to stdout so they're
// visible in `Console.app` (macOS) and Event Viewer (Windows)
// when an alpha tester reports "the helper hasn't updated for
// a week." Don't show a dialog; auto-update is opportunistic
// and a user-facing error popup would feel intrusive for a
// background tray app.
autoUpdater.on("error", (err) => {
  console.error("[autoUpdate] error:", err)
})

app.on("window-all-closed", () => {
  // Tray app: NEVER quit when windows close. User quits from tray menu.
})

app.on("activate", () => {
  // On macOS, re-create tray if needed
})

// Prevent multiple instances
const lock = app.requestSingleInstanceLock()
if (!lock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    // Show login window or notification that app is already running
    if (!appState.isAuthenticated) {
      showLoginWindow()
    }
  })
}
