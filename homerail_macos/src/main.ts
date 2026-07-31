import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { spawn, type ChildProcess } from 'node:child_process'
import { app, BrowserWindow, Menu, nativeImage, ipcMain, session, shell, systemPreferences, Tray } from 'electron'
import { RuntimeSupervisor } from './runtime-supervisor.js'
import { KwsSupervisor } from './kws-supervisor.js'
import { KwsModelManager } from './kws/model-manager.js'
import { SettingsStore } from './settings-store.js'
import { DiagnosticLog } from './diagnostic-log.js'
import { LiveInputLease } from './live-input-lease.js'
import { readSystemOutputSnapshot, type SystemOutputSnapshot } from './system-output-monitor.js'
import type { KwsEvent } from './kws/protocol.js'
import type { MikoAppStatus, MikoEvent, MikoSettingsPatch, RuntimeStatus } from './shared/types.js'

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  void app.whenReady().then(startApplication)
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let settingsStore: SettingsStore
let diagnosticLog: DiagnosticLog
let runtime: RuntimeSupervisor
let kws: KwsSupervisor
let modelManager: KwsModelManager
let runtimeStatus: RuntimeStatus
let kwsState: MikoAppStatus['kwsState'] = 'unavailable'
let kwsTestMode = false
let kwsAudioLevel = 0
let systemOutput: SystemOutputSnapshot = { label: '系统默认输出', transport: 'unknown' }
let systemOutputTimer: NodeJS.Timeout | null = null
let codexStatusTimer: NodeJS.Timeout | null = null
let inputDevices: MikoAppStatus['inputDevices'] = []
let codexLoggedIn = false
let codexLiveSupported = false
let codexLiveEffective = false
let liveSessionActive = false
const liveInputLease = new LiveInputLease(() => {
  liveSessionActive = false
  kwsTestMode = false
  kwsState = 'paused'
  void kws?.pause().catch(() => undefined)
  emit({ type: 'live-input-lease-expired' })
  emit({ type: 'runtime-error', message: 'GPT Live 麦克风会话失去确认，已暂停唤醒监听，请重新开始对话' })
  emitStatus()
})
let codexAuthProcess: ChildProcess | null = null
let quitting = false
const currentDirectory = path.dirname(fileURLToPath(import.meta.url))

function isLocalAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
  } catch {
    return false
  }
}

function microphonePermission(): MikoAppStatus['microphonePermission'] {
  const status = systemPermissionStatus()
  if (status === 'not-determined' || status === 'denied' || status === 'granted' || status === 'restricted') return status
  return 'not-determined'
}

function systemPermissionStatus(): string {
  return typeof systemPreferences?.getMediaAccessStatus === 'function'
    ? systemPreferences.getMediaAccessStatus('microphone')
    : 'not-determined'
}

function getStatus(): MikoAppStatus {
  const settings = settingsStore.snapshot
  let lifecycle: MikoAppStatus['lifecycle'] = 'paused'
  if (!settings.onboardingComplete) lifecycle = 'setup-required'
  else if (runtimeStatus.state === 'error' || runtimeStatus.state === 'unavailable' || kwsState === 'error') lifecycle = 'error'
  else if (liveSessionActive) lifecycle = 'live-listening'
  else if (kwsState === 'listening') lifecycle = 'listening'
  else if (kwsState === 'wake-detected') lifecycle = 'wake-detected'
  return {
    lifecycle,
    runtime: runtimeStatus,
    settings,
    microphonePermission: microphonePermission(),
    selectedInputLabel: settings.inputDevice?.label,
    systemOutputLabel: systemOutput.label,
    systemOutputTransport: systemOutput.transport,
    codexLoggedIn,
    codexLiveSupported,
    codexLiveEffective,
    liveSessionActive,
    kwsState,
    kwsTestMode,
    kwsAudioLevel,
    inputDevices: inputDevices.map(device => ({ ...device, supportedInputConfigs: device.supportedInputConfigs.map(config => ({ ...config })) })),
    wakeModelInstalled: modelManager?.status().installed ?? false,
  }
}

function emit(event: MikoEvent): void {
  if (event.type === 'status') refreshTray()
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('miko:event', event)
}

function emitStatus(): void {
  emit({ type: 'status', status: getStatus() })
}

function refreshTray(): void {
  if (!tray) return
  const status = getStatus()
  const stateLabel = status.lifecycle === 'setup-required'
    ? '需要完成首次设置'
    : status.lifecycle === 'error'
      ? '运行时错误'
      : status.liveSessionActive
        ? 'GPT Live 对话中（麦克风已占用）'
      : status.settings.listeningEnabled
        ? kwsState === 'listening' ? '正在监听“米可”' : '已暂停（等待唤醒设置）'
        : '已暂停'
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `HomeRail Miko：${stateLabel}`, enabled: false },
    { label: `输入：${status.selectedInputLabel || '未选择'}`, enabled: false },
    { label: `输出：${status.systemOutputLabel || '系统默认输出'}`, enabled: false },
    { type: 'separator' },
    { label: '打开 HomeRail', click: () => void showMainWindow() },
    { label: '打开 Miko 设置', click: () => void openMikoSettings() },
    { label: '结束当前对话', click: () => requestEndConversation() },
    {
      label: status.settings.listeningEnabled ? '暂停监听' : '恢复监听',
      click: () => void setListening(!status.settings.listeningEnabled),
    },
    { label: '打开声音设置', click: () => void shell.openExternal('x-apple.systempreferences:com.apple.Sound-Settings.extension') },
    { label: '退出 HomeRail Miko', click: () => app.quit() },
  ]))
}

function requestEndConversation(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    emit({ type: 'conversation-end-requested' })
    return
  }
  void endConversation()
}

async function endConversation(): Promise<MikoAppStatus> {
  liveInputLease.release()
  liveSessionActive = false
  kwsTestMode = false
  kwsState = 'paused'
  await kws.pause()
  if (settingsStore.snapshot.listeningEnabled && settingsStore.snapshot.inputDevice && modelManager.status().installed) {
    try { await startWakeListening() } catch (error) { kwsState = 'error'; emit({ type: 'runtime-error', message: error instanceof Error ? error.message : String(error) }) }
  }
  emitStatus()
  return getStatus()
}

async function setListening(enabled: boolean): Promise<MikoAppStatus> {
  settingsStore.update({ listeningEnabled: enabled })
  if (!enabled) {
    kwsTestMode = false
    await kws?.pause()
  }
  else if (settingsStore.snapshot.inputDevice && modelManager?.status().installed) {
    try { await startWakeListening() } catch (error) { kwsState = 'error'; emit({ type: 'runtime-error', message: error instanceof Error ? error.message : String(error) }) }
  }
  emitStatus()
  return getStatus()
}

function handleKwsEvent(event: KwsEvent): void {
  if (event.type === 'listening') kwsState = 'listening'
  else if (event.type === 'wake') { kwsState = 'wake-detected'; kwsAudioLevel = 0 }
  else if (event.type === 'paused' || event.type === 'device-lost') { kwsState = 'paused'; kwsAudioLevel = 0 }
  else if (event.type === 'error') kwsState = 'error'
  else if (event.type === 'audio-level') kwsAudioLevel = event.rms
  if (event.type === 'wake' && settingsStore.snapshot.wakeSoundEnabled) shell.beep()
  if (event.type === 'wake' && kwsTestMode) {
    kwsTestMode = false
    emit({ type: 'kws-test-wake', detectedAt: event.detectedAt })
  } else emit({ type: 'kws', event })
  emitStatus()
}

async function refreshCodexStatus(): Promise<void> {
  if (!runtime || runtimeStatus.state !== 'ready') {
    codexLoggedIn = false
    codexLiveSupported = false
    codexLiveEffective = false
    return
  }
  try {
    const [codexResponse, readinessResponse] = await Promise.all([
      fetch(`${runtime.managerUrl}/api/voice-agent/codex-status`, { signal: AbortSignal.timeout(2_000) }),
      fetch(`${runtime.managerUrl}/api/manager-agent/readiness`, { signal: AbortSignal.timeout(2_000) }),
    ])
    const body = await codexResponse.json() as { data?: { logged_in?: boolean; live_voice?: { supported?: boolean } } }
    const readiness = await readinessResponse.json() as { data?: { live_voice_effective?: boolean } }
    codexLoggedIn = body.data?.logged_in === true
    codexLiveSupported = body.data?.live_voice?.supported === true
    codexLiveEffective = readiness.data?.live_voice_effective === true
  } catch {
    codexLoggedIn = false
    codexLiveSupported = false
    codexLiveEffective = false
  }
  emitStatus()
}

async function refreshSystemOutput(): Promise<void> {
  const next = await readSystemOutputSnapshot()
  if (next.label === systemOutput.label && next.transport === systemOutput.transport) return
  systemOutput = next
  emitStatus()
}

function codexBinaryPath(): string {
  return process.env.HOMERAIL_CODEX_BIN
    || (app.isPackaged
      ? path.join(process.resourcesPath, 'homerail-runtime', 'codex', 'bin', 'codex')
      : path.join(app.getAppPath(), '.runtime-staging', 'homerail-runtime', 'codex', 'bin', 'codex'))
}

function startCodexAuth(): { started: boolean; message: string } {
  if (codexAuthProcess && codexAuthProcess.exitCode === null) return { started: false, message: 'Codex device authentication is already running' }
  const command = codexBinaryPath()
  codexAuthProcess = spawn(command, ['login', '--device-auth'], {
    cwd: app.getPath('home'),
    env: { ...process.env, HOMERAIL_CODEX_BIN: command },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const stream of [codexAuthProcess.stdout, codexAuthProcess.stderr] as const) {
    if (!stream) continue
    createInterface({ input: stream }).on('line', line => emit({ type: 'codex-auth', stream: stream === codexAuthProcess?.stdout ? 'stdout' : 'stderr', line: line.slice(0, 1_000) }))
  }
  codexAuthProcess.once('error', error => emit({ type: 'codex-auth', stream: 'stderr', line: error.message }))
  codexAuthProcess.once('exit', (code, signal) => {
    emit({ type: 'codex-auth-status', state: code === 0 ? 'completed' : 'failed', code, signal })
    codexAuthProcess = null
    void refreshCodexStatus()
  })
  emit({ type: 'codex-auth-status', state: 'started' })
  return { started: true, message: 'Codex device authentication started' }
}

async function startWakeListening(): Promise<MikoAppStatus> {
  const settings = settingsStore.snapshot
  if (liveSessionActive) throw new Error('请先结束当前 GPT Live 对话')
  if (!settings.inputDevice) throw new Error('请先选择 USB 麦克风')
  const model = modelManager.status()
  if (!model.installed) throw new Error('请先下载并确认 Miko 离线唤醒模型')
  if (microphonePermission() === 'denied' || microphonePermission() === 'restricted') throw new Error('macOS 麦克风权限未授予')
  liveInputLease.release()
  liveSessionActive = false
  kwsTestMode = false
  await kws.configure(model.modelDir, settings.inputDevice.nativeDeviceId, settings.sensitivity)
  await kws.startListening()
  kwsState = 'listening'
  emitStatus()
  return getStatus()
}

async function startKwsTest(): Promise<MikoAppStatus> {
  const settings = settingsStore.snapshot
  if (liveSessionActive) throw new Error('请先结束当前 GPT Live 对话')
  if (!settings.inputDevice) throw new Error('请先选择输入麦克风')
  const model = modelManager.status()
  if (!model.installed) throw new Error('请先下载并确认 Miko 离线唤醒模型')
  if (microphonePermission() === 'denied' || microphonePermission() === 'restricted') throw new Error('macOS 麦克风权限未授予')
  kwsTestMode = true
  try {
    await kws.configure(model.modelDir, settings.inputDevice.nativeDeviceId, settings.sensitivity)
    await kws.startListening()
    kwsState = 'listening'
    emitStatus()
    return getStatus()
  } catch (error) {
    kwsTestMode = false
    throw error
  }
}

async function setLiveSessionActive(active: boolean): Promise<MikoAppStatus> {
  if (active) {
    await kws.pause()
    kwsTestMode = false
    kwsState = 'paused'
    liveInputLease.acquire()
  } else {
    liveInputLease.release()
  }
  liveSessionActive = active
  emitStatus()
  return getStatus()
}

async function renewLiveSessionLease(): Promise<MikoAppStatus> {
  if (liveSessionActive) liveInputLease.renew()
  return getStatus()
}

async function pauseWakeListening(): Promise<MikoAppStatus> {
  kwsTestMode = false
  await kws.pause()
  kwsState = 'paused'
  emitStatus()
  return getStatus()
}

function setupPermissionHandlers(): void {
  const handler = (webContents: Electron.WebContents, permission: string, callback: (allowed: boolean) => void) => {
    callback(
      permission === 'media'
      && isLocalAppUrl(webContents.getURL()),
    )
  }
  session.defaultSession.setPermissionRequestHandler(handler)
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return permission === 'media' && isLocalAppUrl(requestingOrigin)
  })
}

async function createMainWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'HomeRail Miko',
    webPreferences: {
      preload: path.join(currentDirectory, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.on('close', event => {
    if (quitting) return
    event.preventDefault()
    mainWindow?.hide()
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isLocalAppUrl(url)) event.preventDefault()
  })
  await mainWindow.loadURL(setupPageUrl())
}

function setupPageUrl(): string {
  const status = getStatus()
  const safeMessage = (status.runtime.message || '正在准备 HomeRail runtime…').replace(/[<>&]/g, '')
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>HomeRail Miko</title><style>body{font:15px -apple-system,BlinkMacSystemFont,sans-serif;margin:48px;color:#1f2937;background:#f5f6f8}main{max-width:680px;margin:auto;background:white;padding:32px;border:1px solid #d9dde5;border-radius:8px}h1{margin-top:0;font-size:24px}p{line-height:1.6}.status{padding:12px;background:#f0f2f5;border-radius:6px}</style><main><h1>HomeRail Miko</h1><p>常驻语音助手正在准备本地 runtime。完成 runtime、麦克风和 Codex 设置后，这里会自动打开 HomeRail。</p><div class="status">${safeMessage}</div><p>当前状态：${status.lifecycle}</p></main>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

async function showMainWindow(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (runtimeStatus.state === 'ready' && mainWindow.webContents.getURL() !== runtime.uiUrl) await mainWindow.loadURL(runtime.uiUrl)
  mainWindow.show()
  mainWindow.focus()
}

async function openMikoSettings(): Promise<void> {
  await showMainWindow()
  emit({ type: 'settings-requested' })
}

function createTray(): void {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'homerail-runtime', 'agent-ui', 'icons', 'homerail-icon-32.png')
    : path.resolve(app.getAppPath(), '..', 'agent-ui', 'public', 'icons', 'homerail-icon-32.png')
  const icon = nativeImage.createFromPath(iconPath)
  if (!icon.isEmpty()) icon.setTemplateImage(true)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setTitle('Miko')
  tray.on('click', () => void showMainWindow())
  refreshTray()
}

function setupIpc(): void {
  ipcMain.handle('miko:get-status', () => getStatus())
  ipcMain.handle('miko:get-settings', () => settingsStore.snapshot)
  ipcMain.handle('miko:update-settings', (_event, patch: MikoSettingsPatch) => {
    const next = settingsStore.update(patch)
    if (patch.startAtLogin !== undefined) app.setLoginItemSettings({ openAtLogin: next.startAtLogin, openAsHidden: true })
    emitStatus()
    return next
  })
  ipcMain.handle('miko:set-listening', (_event, enabled: boolean) => setListening(Boolean(enabled)))
  ipcMain.handle('miko:list-input-devices', async () => {
    inputDevices = await kws.listDevices()
    emitStatus()
    return inputDevices
  })
  ipcMain.handle('miko:install-wake-model', async (_event, confirmedSourceTerms: boolean) => {
    try {
      const status = await modelManager.ensureInstalled({ allowDownload: true, confirmedSourceTerms: Boolean(confirmedSourceTerms) })
      emitStatus()
      return { installed: status.installed, modelDir: status.modelDir }
    } catch (error) {
      return { installed: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('miko:start-wake-listening', () => startWakeListening())
  ipcMain.handle('miko:start-kws-test', () => startKwsTest())
  ipcMain.handle('miko:set-live-active', (_event, active: boolean) => setLiveSessionActive(Boolean(active)))
  ipcMain.handle('miko:renew-live-lease', () => renewLiveSessionLease())
  ipcMain.handle('miko:pause-wake-listening', () => pauseWakeListening())
  ipcMain.handle('miko:end-conversation', () => endConversation())
  ipcMain.handle('miko:start-codex-auth', () => startCodexAuth())
  ipcMain.handle('miko:open-home-rail', () => showMainWindow())
  ipcMain.handle('miko:open-sound-settings', () => shell.openExternal('x-apple.systempreferences:com.apple.Sound-Settings.extension'))
  ipcMain.handle('miko:show-window', () => showMainWindow())
  ipcMain.handle('miko:quit', () => app.quit())
}

async function startApplication(): Promise<void> {
  app.setName('HomeRail Miko')
  settingsStore = new SettingsStore(path.join(app.getPath('userData'), 'miko-settings.json'))
  diagnosticLog = new DiagnosticLog(app.getPath('userData'))
  modelManager = new KwsModelManager(path.join(app.getPath('userData'), 'models'))
  kws = new KwsSupervisor({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    onEvent: handleKwsEvent,
    onLog: (stream, line) => { diagnosticLog.append(stream, line); emit({ type: 'runtime-log', stream, line }) },
  })
  runtime = new RuntimeSupervisor({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData'),
    onStatus: status => {
      runtimeStatus = status
      emitStatus()
      if (status.state === 'ready' && mainWindow && !mainWindow.isDestroyed()) void mainWindow.loadURL(runtime.uiUrl)
      if (status.state === 'ready') void refreshCodexStatus()
    },
    onLog: (stream, line) => { diagnosticLog.append(stream, line); emit({ type: 'runtime-log', stream, line }) },
  })
  runtimeStatus = runtime.snapshot
  setupPermissionHandlers()
  setupIpc()
  await createMainWindow()
  createTray()
  await refreshSystemOutput()
  systemOutputTimer = setInterval(() => void refreshSystemOutput(), 5_000)
  codexStatusTimer = setInterval(() => void refreshCodexStatus(), 5_000)
  if (settingsStore.snapshot.startAtLogin) app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })
  emitStatus()
  await runtime.start()
  await refreshCodexStatus()
  if (settingsStore.snapshot.onboardingComplete && settingsStore.snapshot.listeningEnabled) {
    void startWakeListening().catch(error => {
      kwsState = 'error'
      emit({ type: 'runtime-error', message: error instanceof Error ? error.message : String(error) })
      emitStatus()
    })
  }
}

app.on('second-instance', () => void showMainWindow())
app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  liveInputLease.release()
  if (systemOutputTimer) clearInterval(systemOutputTimer)
  systemOutputTimer = null
  if (codexStatusTimer) clearInterval(codexStatusTimer)
  codexStatusTimer = null
  codexAuthProcess?.kill('SIGTERM')
  void Promise.all([kws?.stop(), runtime?.stop()]).finally(() => app.exit(0))
})
app.on('window-all-closed', () => {})
