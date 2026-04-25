import { contextBridge, ipcRenderer } from "electron"

/**
 * Preload script for the login window.
 * Exposes a safe API bridge to the renderer process.
 */
contextBridge.exposeInMainWorld("electronAPI", {
  sendOTP: (email: string) => ipcRenderer.invoke("auth:send-otp", email),
  verifyOTP: (email: string, otp: string) => ipcRenderer.invoke("auth:verify-otp", email, otp),
})
