/**
 * Jest mock for the `electron` module.
 *
 * Most helper modules import a small surface of electron APIs
 * (`app.getPath`, `BrowserWindow`, `ipcMain`, `powerMonitor`,
 * `Tray`, `Menu`, `nativeImage`, `Notification`). Jest tests
 * for behavior modules don't need a real Electron runtime —
 * they need predictable stubs.
 *
 * This mock keeps each surface narrow:
 *   - `app.getPath('userData')` returns a per-test temp dir
 *     under the OS tmpdir so persistence tests can use the real
 *     `fs` module without leaking between cases.
 *   - `BrowserWindow`, `Tray`, `nativeImage` are no-op stubs.
 *   - `powerMonitor` is an EventEmitter so suspend/resume tests
 *     can synthesize OS events.
 *
 * Each behavior test that touches one of these can override
 * surface points via `jest.mock("electron")` if it needs a
 * different shape; this file is the default.
 */

import { EventEmitter } from "events"
import { tmpdir } from "os"
import { join } from "path"
import { mkdtempSync } from "fs"

const sessionTempDir = mkdtempSync(join(tmpdir(), "ggih-jest-"))

export const app = {
  getPath: jest.fn((kind: string) => {
    if (kind === "userData") return sessionTempDir
    return sessionTempDir
  }),
  whenReady: jest.fn(() => Promise.resolve()),
  on: jest.fn(),
  quit: jest.fn(),
  dock: { hide: jest.fn() },
  setLoginItemSettings: jest.fn(),
  isPackaged: false,
}

export class BrowserWindow {
  loadURL = jest.fn()
  close = jest.fn()
  isDestroyed = jest.fn(() => false)
  on = jest.fn()
  webContents = { send: jest.fn() }
}

export const ipcMain = {
  handle: jest.fn(),
  handleOnce: jest.fn(),
  removeHandler: jest.fn(),
}

export const powerMonitor = new EventEmitter()

export class Tray {
  setToolTip = jest.fn()
  setContextMenu = jest.fn()
  on = jest.fn()
  destroy = jest.fn()
}

export const Menu = {
  buildFromTemplate: jest.fn(() => ({ items: [] })),
  setApplicationMenu: jest.fn(),
}

export const nativeImage = {
  createFromPath: jest.fn(() => ({ isEmpty: () => false })),
  createEmpty: jest.fn(() => ({ isEmpty: () => true })),
}

export const Notification = jest.fn().mockImplementation(() => ({
  show: jest.fn(),
  on: jest.fn(),
}))

export const dialog = {
  showOpenDialog: jest.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
}

export const shell = {
  openExternal: jest.fn(),
}
