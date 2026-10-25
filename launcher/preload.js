'use strict'
// The only bridge between the window and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('bwb', {
  call: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (event, fn) => {
    const h = (_e, data) => fn(data)
    ipcRenderer.on(event, h)
    return () => ipcRenderer.removeListener(event, h)
  },
  pathForFile: (file) => webUtils.getPathForFile(file)
})
