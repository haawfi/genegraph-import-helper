import keytar from "keytar"
import axios from "axios"
import os from "os"
import { app } from "electron"

/**
 * AuthManager
 *
 * Manages authentication with GeneGraph API using system keychain for secure storage.
 * Uses keytar to store auth tokens in OS-specific secure storage:
 * - macOS: Keychain
 * - Windows: Credential Manager
 * - Linux: Pass or custom backend
 *
 * Auth flow (OTP):
 *   1. requestOTP(email)           → server sends 6-digit code to email
 *   2. verifyOTP(email, otp)       → server verifies code, returns device-scoped JWT
 *   3. Token stored in keychain    → survives app restarts
 *   4. Token refreshed proactively → before 8h expiry
 *
 * Future eID flow (browser handoff):
 *   1. startEidAuth()              → returns URL to open in external browser
 *   2. pollForEidToken(sessionId)  → polls server until user completes eID in browser
 *   3. Same token format stored    → identical keychain storage, same refresh flow
 *
 * The auth manager is deliberately auth-method-agnostic in its token storage
 * and refresh layer. Only the initial authentication differs per method.
 */

// ─── Keychain Constants ─────────────────────────────────────────────────────

const SERVICE_NAME = "GeneGraph Desktop Helper"
const TOKEN_KEY = "device_token"
const USER_KEY = "user_email"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DeviceInfo {
  deviceId: string
  deviceName: string
  os: "MACOS" | "WINDOWS" | "LINUX"
  appVersion: string
}

/** Verification tier — display-only trust level, matches web app model */
export type VerificationTier = "email" | "identity" | "bank"

interface TokenData {
  token: string
  expiresAt: number // Unix timestamp (seconds)
  userId: string
  verificationTier?: VerificationTier // added for tier-aware UI
}

export class AuthManager {
  private readonly apiBaseUrl: string
  private readonly deviceInfo: DeviceInfo
  private refreshTimer: NodeJS.Timeout | null = null

  constructor(apiBaseUrl?: string) {
    this.apiBaseUrl = apiBaseUrl || process.env.API_BASE_URL || "https://www.genegraph.eu"
    this.deviceInfo = this.buildDeviceInfo()
  }

  // ── OTP Auth Flow ───────────────────────────────────────────────────────

  /**
   * Step 1: Request OTP to be sent to user's email.
   */
  async requestOTP(email: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await axios.post(
        `${this.apiBaseUrl}/api/auth/desktop/send-otp`,
        { email },
        { timeout: 10000 }
      )
      return { success: true }
    } catch (error) {
      const msg = axios.isAxiosError(error)
        ? error.response?.data?.error || error.message
        : "Failed to send code"
      console.error("[AuthManager] requestOTP failed:", msg)
      return { success: false, error: msg }
    }
  }

  /**
   * Step 2: Verify OTP and receive device-scoped token.
   * Stores token in system keychain on success.
   */
  async verifyOTP(
    email: string,
    otp: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await axios.post(
        `${this.apiBaseUrl}/api/auth/desktop/verify-otp`,
        {
          email,
          otp,
          ...this.deviceInfo,
        },
        { timeout: 10000 }
      )

      const { token, expiresAt, userId, verificationTier } = response.data

      // Store token, user email, and verification tier in keychain
      await this.storeToken({ token, expiresAt, userId, verificationTier: verificationTier || "email" })
      await keytar.setPassword(SERVICE_NAME, USER_KEY, email)

      // Schedule proactive refresh
      this.scheduleRefresh(expiresAt)

      console.log("[AuthManager] OTP verified, device token stored")
      return { success: true }
    } catch (error) {
      const msg = axios.isAxiosError(error)
        ? error.response?.data?.error || error.message
        : "Verification failed"
      console.error("[AuthManager] verifyOTP failed:", msg)
      return { success: false, error: msg }
    }
  }

  // ── eID Auth Flow (future — architecture placeholder) ───────────────────

  /**
   * Start eID authentication via external browser.
   * Returns a URL the user should open in their default browser.
   *
   * NOT YET IMPLEMENTED — included as the architectural contract
   * that the eID flow will fulfil. The token storage, refresh, and
   * verification paths are already method-agnostic and will work
   * unchanged when this is implemented.
   */
  async startEidAuth(): Promise<{ available: false; reason: "deferred" }> {
    // DH1 — eID is deferred until investor/grant funding lands
    // (per `docs/strategy.md` and project_pricing_model.md). The
    // architectural contract for the future implementation is
    // preserved in the comment block below; the runtime contract
    // is now a structured "not available" return rather than a
    // throw, so callers can branch cleanly without try/catch.
    //
    // Future shape (when implemented):
    //   POST /api/auth/desktop/eid/start
    //   → { url: "https://genegraph.eu/auth/eid?session=...",
    //       sessionId: "..." }
    //   Electron opens the URL via shell.openExternal(url),
    //   then polls pollForEidToken(sessionId) on an interval.
    return { available: false, reason: "deferred" }
  }

  /**
   * Poll server for eID auth completion.
   *
   * DH1 — deferred along with `startEidAuth`. Returns the same
   * structured "not available" shape so the auth flow can skip
   * the eID branch without exception handling.
   *
   * Future shape (when implemented):
   *   GET /api/auth/desktop/eid/poll?sessionId=...
   *   → { complete: false } while user is in browser,
   *     then { complete: true, token: "...", expiresAt: ...,
   *            userId: "..." }
   */
  async pollForEidToken(
    _sessionId: string,
  ): Promise<{ available: false; reason: "deferred" }> {
    return { available: false, reason: "deferred" }
  }

  // ── Token Management (method-agnostic) ──────────────────────────────────

  /**
   * Get stored auth token. Returns null if not authenticated or token expired.
   */
  async getToken(): Promise<string | null> {
    try {
      const raw = await keytar.getPassword(SERVICE_NAME, TOKEN_KEY)
      if (!raw) return null

      const data: TokenData = JSON.parse(raw)

      // Check local expiry (avoid unnecessary server round-trip)
      const now = Math.floor(Date.now() / 1000)
      if (data.expiresAt <= now) {
        console.warn("[AuthManager] Stored token expired locally")
        await this.clearCredentials()
        return null
      }

      return data.token
    } catch (error) {
      console.error("[AuthManager] Failed to retrieve token:", error)
      return null
    }
  }

  /**
   * Check if user is authenticated (token exists and server confirms valid).
   */
  async isAuthenticated(): Promise<boolean> {
    try {
      const token = await this.getToken()
      if (!token) return false

      const response = await axios.get(
        `${this.apiBaseUrl}/api/auth/desktop/verify`,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 5000,
        }
      )

      if (response.data.valid) {
        // Re-schedule refresh if we haven't already
        const raw = await keytar.getPassword(SERVICE_NAME, TOKEN_KEY)
        if (raw) {
          const data: TokenData = JSON.parse(raw)
          this.scheduleRefresh(data.expiresAt)
          // Update verification tier from server (may have changed since last login)
          const serverTier = response.data.verificationTier as VerificationTier | undefined
          if (serverTier && serverTier !== data.verificationTier) {
            data.verificationTier = serverTier
            await this.storeToken(data)
          }
        }
        return true
      }

      return false
    } catch (error) {
      console.warn("[AuthManager] Token verification failed:", error)
      return false
    }
  }

  /**
   * Refresh token proactively (called before expiry).
   */
  async refreshToken(): Promise<boolean> {
    try {
      const currentToken = await this.getToken()
      if (!currentToken) return false

      const response = await axios.post(
        `${this.apiBaseUrl}/api/auth/desktop/refresh`,
        {},
        {
          headers: { Authorization: `Bearer ${currentToken}` },
          timeout: 10000,
        }
      )

      const { token, expiresAt } = response.data

      // Get existing userId from stored data
      const raw = await keytar.getPassword(SERVICE_NAME, TOKEN_KEY)
      const oldData: TokenData = raw ? JSON.parse(raw) : { userId: "" }

      await this.storeToken({ token, expiresAt, userId: oldData.userId })
      this.scheduleRefresh(expiresAt)

      console.log("[AuthManager] Token refreshed successfully")
      return true
    } catch (error) {
      console.error("[AuthManager] Token refresh failed:", error)
      return false
    }
  }

  /**
   * Get stored user email (for display in tray menu / UI).
   */
  async getUserEmail(): Promise<string | null> {
    try {
      return await keytar.getPassword(SERVICE_NAME, USER_KEY)
    } catch {
      return null
    }
  }

  /**
   * Get the user's verification tier (for display in tray menu / UI).
   * Returns "email" as safe default if not stored or unavailable.
   */
  async getVerificationTier(): Promise<VerificationTier> {
    try {
      const raw = await keytar.getPassword(SERVICE_NAME, TOKEN_KEY)
      if (!raw) return "email"
      const data: TokenData = JSON.parse(raw)
      return data.verificationTier || "email"
    } catch {
      return "email"
    }
  }

  /**
   * Get the web app base URL (for opening browser links).
   */
  getBaseUrl(): string {
    return this.apiBaseUrl
  }

  /**
   * Logout: clear all credentials and cancel refresh timer.
   */
  async logout(): Promise<void> {
    this.cancelRefresh()
    await this.clearCredentials()
    console.log("[AuthManager] Logged out")
  }

  /**
   * Clean up: cancel timers. Call on app quit.
   */
  destroy(): void {
    this.cancelRefresh()
  }

  // ── Internal Helpers ────────────────────────────────────────────────────

  private async storeToken(data: TokenData): Promise<void> {
    await keytar.setPassword(SERVICE_NAME, TOKEN_KEY, JSON.stringify(data))
  }

  async clearCredentials(): Promise<void> {
    try {
      await keytar.deletePassword(SERVICE_NAME, TOKEN_KEY)
      await keytar.deletePassword(SERVICE_NAME, USER_KEY)
    } catch (error) {
      console.warn("[AuthManager] clearCredentials warning:", error)
    }
  }

  /**
   * Schedule a token refresh 30 minutes before expiry.
   * If less than 30 minutes remain, refresh in 1 minute.
   */
  private scheduleRefresh(expiresAt: number): void {
    this.cancelRefresh()

    const now = Math.floor(Date.now() / 1000)
    const refreshBuffer = 30 * 60 // 30 minutes before expiry
    const refreshAt = expiresAt - refreshBuffer
    const delaySeconds = Math.max(refreshAt - now, 60) // At least 1 minute

    this.refreshTimer = setTimeout(async () => {
      const success = await this.refreshToken()
      if (!success) {
        console.warn("[AuthManager] Proactive refresh failed, user will need to re-auth")
      }
    }, delaySeconds * 1000)
  }

  private cancelRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  private buildDeviceInfo(): DeviceInfo {
    const platform = process.platform
    const osType: DeviceInfo["os"] =
      platform === "darwin" ? "MACOS" :
      platform === "win32" ? "WINDOWS" : "LINUX"

    return {
      deviceId: `${os.hostname()}-${platform}-${os.userInfo().username}`,
      deviceName: os.hostname(),
      os: osType,
      // DH1 — sourced from Electron at runtime via `app.getVersion()`,
      // which itself reads `package.json#version` at packaging time.
      // No more hardcoded "1.0.0"; the heartbeat to the server now
      // sends the real version baked into the binary.
      appVersion: app.getVersion(),
    }
  }
}
