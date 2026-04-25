import { contextBridge, ipcRenderer } from "electron"

/**
 * Preload script for the upload confirmation window.
 */
contextBridge.exposeInMainWorld("electronConfirmAPI", {
  approve: () => ipcRenderer.invoke("confirm:approve"),
  reject: () => ipcRenderer.invoke("confirm:reject"),
})
