'use strict'
// Electron main process: owns all files and processes. The window only asks through the preload bridge.
const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron')

const { loadState, saveState, layout, MC_VERSION, DATA_VERSION } = require('./lib/state')
const java = require('./lib/java')
const server = require('./lib/server')
const worlds = require('./lib/worlds')
const settings = require('./lib/settings')
const foundry = require('./lib/foundry')
const { Runner } = require('./lib/runner')
const { computeStatus } = require('./lib/status')

const HOME = process.env.BWB_LAUNCHER_HOME || app.getPath('userData')
const BUNDLED = path.join(__dirname, 'bundled')
const BUNDLED_MODULE = path.join(BUNDLED, 'module')
const RELAY_ENTRY = path.join(BUNDLED, 'relay', 'src', 'index.js')
const OPEN_URLS = new Set([server.EULA_URL, 'https://adoptium.net/temurin/releases/?version=21'])

let win = null
let state = loadState(HOME)
let javaInfo = null
let busy = null // { id, label, done, total }
const runner = new Runner()
const logs = { server: [], relay: [] }

const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data) }
const save = () => saveState(HOME, state)
const refreshJava = () => { javaInfo = java.findJava(HOME, state); return javaInfo }

function snapshot () {
  javaInfo ??= refreshJava()
  const status = computeStatus({ home: HOME, state, runner, bundledModule: BUNDLED_MODULE, java: javaInfo })
  return {
    state,
    status,
    worlds: worlds.listWorlds(HOME),
    presets: Object.fromEntries(Object.entries(settings.PRESETS).map(([k, p]) => [k, { label: p.label, radius: p.viewer.radius, refreshMs: p.map.refreshMs, refreshRadius: p.map.refreshRadius }])),
    foundryDefault: foundry.defaultDataPath(),
    bundledModuleVersion: foundry.readVersion(BUNDLED_MODULE),
    mcVersion: MC_VERSION,
    dataVersion: DATA_VERSION,
    paths: { home: HOME, server: layout(HOME).server },
    busy,
    logs
  }
}

const push = () => send('snapshot', snapshot())

function assertStopped () {
  const r = runner.status()
  if (r.mc !== 'stopped' || r.relay !== 'stopped') throw new Error('서버가 실행 중입니다. 실행 탭에서 정지한 뒤 바꾸세요.')
}

async function withBusy (id, label, fn) {
  if (busy) throw new Error(`${busy.label} 작업이 끝날 때까지 기다리세요.`)
  busy = { id, label, done: 0, total: 0 }
  push()
  let last = 0
  const onProgress = (done, total) => {
    busy.done = done; busy.total = total
    const now = Date.now()
    if (now - last > 120) { last = now; send('progress', busy) }
  }
  try {
    return await fn(onProgress)
  } finally {
    busy = null
  }
}

async function pickPath (opts) {
  const r = await dialog.showOpenDialog(win, opts)
  return r.canceled ? null : r.filePaths[0]
}

/** Every handler returns { ok, error? } and the window gets a fresh snapshot afterwards. */
const handlers = {
  snapshot: () => null,

  'java:check': () => { refreshJava() },
  'java:install': () => withBusy('java', 'Java 받기', async (onProgress) => {
    await java.installJava(HOME, { onProgress })
    refreshJava()
  }),
  'java:pick': async () => {
    const p = await pickPath({ title: 'java 실행 파일 고르기', properties: ['openFile'] })
    if (!p) return
    const major = java.probe(p)
    if (major == null) throw new Error('그 파일은 Java 로 실행되지 않습니다.')
    if (major < java.MIN_JAVA) throw new Error(`Java ${major} 입니다. ${java.MIN_JAVA} 이상이 필요합니다.`)
    state.javaPath = p; save(); refreshJava()
  },

  'server:type': (type) => {
    assertStopped()
    if (!['paper', 'vanilla'].includes(type)) throw new Error('알 수 없는 서버 종류입니다.')
    state.serverType = type; save()
  },
  'server:eula': (accepted) => {
    assertStopped()
    server.writeEula(HOME, !!accepted)
    state.eulaAccepted = !!accepted; save()
  },
  'server:download': () => {
    assertStopped()
    const type = state.serverType
    return withBusy('server', '서버 받기', async (onProgress) => {
      state.installedServer = await server.downloadServer(HOME, type, { onProgress })
      save()
    })
  },

  'world:importFolder': async () => {
    assertStopped()
    const p = await pickPath({ title: '마인크래프트 월드 폴더 고르기', properties: ['openDirectory'] })
    if (!p) return
    const name = await withBusy('world', '맵 복사', async () => worlds.importFolder(HOME, p))
    worlds.selectWorld(HOME, state, name); save()
  },
  'world:importZip': async (zipPath) => {
    assertStopped()
    const p = zipPath || await pickPath({ title: '맵 zip 고르기', properties: ['openFile'], filters: [{ name: 'zip', extensions: ['zip'] }] })
    if (!p) return
    if (!/\.zip$/i.test(p)) throw new Error('zip 파일만 가져올 수 있습니다. 폴더는 "폴더에서 가져오기"를 쓰세요.')
    const name = await withBusy('world', '맵 압축 풀기', async () => worlds.importZip(HOME, p))
    worlds.selectWorld(HOME, state, name); save()
  },
  'world:dropFolder': async (dir) => {
    assertStopped()
    const name = await withBusy('world', '맵 복사', async () => worlds.importFolder(HOME, dir))
    worlds.selectWorld(HOME, state, name); save()
  },
  'world:create': (name, type) => {
    assertStopped()
    if (!['flat', 'normal'].includes(type)) throw new Error('맵 종류는 평면 또는 일반입니다.')
    if (worlds.listWorlds(HOME).some((w) => w.name === name)) throw new Error('같은 이름의 맵이 이미 있습니다.')
    worlds.selectWorld(HOME, state, String(name ?? '').trim(), type); save()
  },
  'world:select': (name) => { assertStopped(); worlds.selectWorld(HOME, state, name); save() },
  'world:openFolder': () => { fs.mkdirSync(layout(HOME).server, { recursive: true }); shell.openPath(layout(HOME).server) },

  'settings:save': (partial = {}) => {
    assertStopped()
    const next = { ...state }
    if ('onlineMode' in partial) next.onlineMode = !!partial.onlineMode
    if ('preset' in partial) {
      if (!settings.PRESETS[partial.preset]) throw new Error('알 수 없는 프리셋입니다.')
      next.preset = partial.preset
    }
    if ('memoryGB' in partial) {
      const m = Number(partial.memoryGB)
      if (!Number.isInteger(m) || m < 1 || m > 32) throw new Error('메모리는 1~32 GB 사이로 고르세요.')
      next.memoryGB = m
    }
    for (const k of ['mcPort', 'rconPort', 'relayPort']) if (k in partial) next[k] = Number(partial[k])
    state = next; save()
  },
  'settings:apply': () => { assertStopped(); settings.applySettings(HOME, state); save() },

  'foundry:pick': async () => {
    const p = await pickPath({ title: 'Foundry 데이터(Data) 폴더 고르기', properties: ['openDirectory'], defaultPath: state.foundryData || foundry.defaultDataPath() })
    if (!p) return
    const data = foundry.resolveDataPath(p)
    if (!data) throw new Error('Foundry 데이터 폴더가 아닙니다. modules·worlds·systems 폴더가 들어 있는 Data 폴더를 고르세요.')
    state.foundryData = data; save()
  },
  'foundry:useDefault': () => {
    const data = foundry.resolveDataPath(foundry.defaultDataPath())
    if (!data) throw new Error('기본 위치에 Foundry 데이터 폴더가 없습니다. Foundry 를 한 번 실행했는지 확인하거나 폴더를 직접 고르세요.')
    state.foundryData = data; save()
  },
  'module:install': () => withBusy('module', '모듈 설치', async () => { foundry.installModule(state.foundryData, BUNDLED_MODULE) }),

  'run:start': async () => {
    const st = computeStatus({ home: HOME, state, runner, bundledModule: BUNDLED_MODULE, java: javaInfo ?? refreshJava() })
    if (!st.readyToRun) throw new Error('Java·서버 준비·맵 선택·설정 적용이 모두 초록불이어야 시작할 수 있습니다.')
    logs.server.length = 0; logs.relay.length = 0
    await runner.start({
      javaPath: javaInfo.path,
      serverDir: layout(HOME).server,
      memoryGB: state.memoryGB,
      mcPort: state.mcPort,
      relayPort: state.relayPort,
      relayEntry: RELAY_ENTRY,
      relayConfig: layout(HOME).relayConfig
    })
    if (state.pendingWorld) { state.pendingWorld = null; save() }
  },
  'run:stop': () => runner.stop(),
  'run:command': (text) => runner.command(text),

  clipboard: (text) => { clipboard.writeText(String(text ?? '')) },
  'open:url': (url) => { if (OPEN_URLS.has(url)) shell.openExternal(url) }
}

for (const [ch, fn] of Object.entries(handlers)) {
  ipcMain.handle(ch, async (_e, ...args) => {
    try {
      await fn(...args)
      return { ok: true, snapshot: snapshot() }
    } catch (err) {
      return { ok: false, error: err.message, snapshot: snapshot() }
    }
  })
}

runner.on('status', push)
runner.on('log', (entry) => {
  const list = entry.src === 'relay' ? logs.relay : logs.server // launcher notes go with the server log
  list.push(entry)
  if (list.length > 1000) list.splice(0, list.length - 1000)
  send('log', entry)
})

function createWindow () {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 620,
    title: 'Blockworld Bridge',
    backgroundColor: '#f4f1ea',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (process.env.BWB_SCREENSHOT) {
    // test hook: open a tab, capture, quit
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 600))
      if (process.env.BWB_SCREENSHOT_JS) { await win.webContents.executeJavaScript(process.env.BWB_SCREENSHOT_JS); await new Promise((r) => setTimeout(r, 800)) }
      if (process.env.BWB_SCREENSHOT_TAB) await win.webContents.executeJavaScript(`window.__showTab(${JSON.stringify(process.env.BWB_SCREENSHOT_TAB)})`)
      await new Promise((r) => setTimeout(r, 300))
      const img = await win.webContents.capturePage()
      fs.writeFileSync(process.env.BWB_SCREENSHOT, img.toPNG())
      app.exit(0)
    })
  }
}

// Closing the window stops relay and server first (the world is saved by `stop`).
let quitting = false
app.on('before-quit', (e) => {
  const r = runner.status()
  if (quitting || (r.mc === 'stopped' && r.relay === 'stopped')) return
  e.preventDefault()
  quitting = true
  runner.stop().finally(() => app.quit())
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
