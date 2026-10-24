import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("shibaDiff", {
  patch: (): Promise<string> => ipcRenderer.invoke("desktop:diff-payload"),
});
