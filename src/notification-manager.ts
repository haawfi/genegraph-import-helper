import { Notification } from "electron"

/**
 * NotificationManager
 *
 * Sends desktop notifications to user for key events:
 * - Archive detection
 * - Upload progress
 * - Upload completion
 * - Errors
 *
 * Uses Electron's Notification API to display OS-native notifications
 * (macOS, Windows, Linux compatible).
 */
export class NotificationManager {
  /**
   * Show notification for detected Takeout archive
   */
  showDetection(filename: string): void {
    this.notify({
      title: "Takeout Archive Detected",
      body: `Found: ${filename}`,
      silent: false,
    })
  }

  /**
   * Show notification for upload progress
   */
  showUploadProgress(filename: string, percent: number): void {
    // Only show every 10%
    if (percent % 10 === 0 || percent === 100) {
      this.notify({
        title: "Uploading to FamVault",
        body: `${filename}\n${percent}% complete`,
        silent: true,
      })
    }
  }

  /**
   * Show notification for upload completion
   */
  showUploadComplete(filename: string, itemCount: number): void {
    const itemText = itemCount > 0 ? ` (${itemCount} items)` : ""
    this.notify({
      title: "Upload Complete",
      body: `Successfully uploaded: ${filename}${itemText}`,
      silent: false,
    })
  }

  /**
   * Show error notification
   */
  showError(message: string): void {
    this.notify({
      title: "FamVault Error",
      body: message,
      silent: false,
      urgency: "critical",
    })
  }

  /**
   * Internal method to show notification
   */
  private notify(options: {
    title: string
    body: string
    silent: boolean
    urgency?: "normal" | "critical" | "low"
  }): void {
    try {
      new Notification({
        title: options.title,
        body: options.body,
        silent: options.silent,
        urgency: options.urgency || "normal",
      }).show()
    } catch (error) {
      console.error("[NotificationManager] Failed to show notification:", error)
    }
  }
}
