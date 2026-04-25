import { app } from "electron"
import path from "path"
import fs from "fs"

/**
 * SettingsStore
 *
 * Persists user settings to a JSON file in the app's user data
 * directory. Simple, synchronous, no external dependencies.
 *
 * After DH1 the productName changed from "FamVault Desktop Helper"
 * to "GeneGraph Import Helper", so Electron now writes settings to
 * a NEW directory:
 *
 *   macOS:   ~/Library/Application Support/GeneGraph Import Helper/settings.json
 *   Windows: %APPDATA%/GeneGraph Import Helper/settings.json
 *
 * Existing alpha testers' old `FamVault Desktop Helper/` settings
 * directory is left in place (settings are small — watch path,
 * auto-launch flag, recent uploads list — so re-deriving them on
 * first launch of the renamed app is a tolerable migration cost).
 * The keychain auth token is preserved across the rename because
 * `auth-manager.ts` keys keytar on a separate `SERVICE_NAME`
 * string that stayed unchanged.
 */

export interface AppSettings {
  watchPath: string
  autoStartEnabled: boolean
  recentUploads: string[]
  apiBaseUrl: string
}

const DEFAULT_SETTINGS: AppSettings = {
  watchPath: "",  // will default to ~/Downloads at runtime
  autoStartEnabled: false,
  recentUploads: [],
  apiBaseUrl: "https://www.genegraph.eu",
}

export class SettingsStore {
  private filePath: string
  private data: AppSettings

  constructor() {
    const userDataPath = app.getPath("userData")
    this.filePath = path.join(userDataPath, "settings.json")
    this.data = this.load()
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.data[key]
  }

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.data[key] = value
    this.save()
  }

  getAll(): Readonly<AppSettings> {
    return { ...this.data }
  }

  private load(): AppSettings {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8")
        const parsed = JSON.parse(raw)
        return { ...DEFAULT_SETTINGS, ...parsed }
      }
    } catch (error) {
      console.warn("[SettingsStore] Failed to load settings, using defaults:", error)
    }
    return { ...DEFAULT_SETTINGS }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8")
    } catch (error) {
      console.error("[SettingsStore] Failed to save settings:", error)
    }
  }
}
