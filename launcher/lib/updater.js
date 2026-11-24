'use strict'
// The launcher updates itself from the GitHub releases (electron-updater): on start it looks for a
// newer launcher, downloads it in the background, and the window offers "다시 시작해 업데이트".
// Settings, worlds and the server stay where they are (they live in the user's data folder).
// Only in the installed app: run from source (npm start) there is nothing to update.

const RECHECK_MS = 6 * 60 * 60 * 1000

/**
 * @param {object} o
 * @param {import('electron').App} o.app
 * @param {(state: object) => void} o.onState  {state: idle|checking|none|downloading|ready|error, version?, percent?, error?}
 * @param {object} [o.updater]  for tests: an autoUpdater-like object
 */
function startUpdater ({ app, onState, updater }) {
  let state = { state: 'idle' }
  const set = (s) => { state = s; onState(s) }
  if (!updater) {
    if (!app.isPackaged) return { state: () => state, install: () => false, check: () => {} }
    try { updater = require('electron-updater').autoUpdater } catch { return { state: () => state, install: () => false, check: () => {} } }
  }
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true // downloaded and the window closed: installed on the way out
  updater.on('checking-for-update', () => { if (state.state !== 'ready') set({ state: 'checking' }) })
  updater.on('update-not-available', () => { if (state.state !== 'ready') set({ state: 'none' }) })
  updater.on('update-available', (info) => set({ state: 'downloading', version: info?.version, percent: 0 }))
  updater.on('download-progress', (p) => set({ state: 'downloading', version: state.version, percent: Math.round(p?.percent ?? 0) }))
  updater.on('update-downloaded', (info) => set({ state: 'ready', version: info?.version }))
  updater.on('error', (err) => { if (state.state !== 'ready') set({ state: 'error', error: String(err?.message ?? err).slice(0, 200) }) })
  const check = () => { Promise.resolve(updater.checkForUpdates()).catch(() => {}) }
  check()
  const timer = setInterval(check, RECHECK_MS)
  timer.unref?.()
  return {
    state: () => state,
    check,
    /** Quit, install the downloaded version quietly and start it again. */
    install: () => {
      if (state.state !== 'ready') return false
      updater.quitAndInstall(true, true)
      return true
    }
  }
}

module.exports = { startUpdater }
