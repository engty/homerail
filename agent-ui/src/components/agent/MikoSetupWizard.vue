<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

const emit = defineEmits<{ completed: [] }>()

type MikoApi = {
  getStatus: () => Promise<any>
  getSettings: () => Promise<any>
  updateSettings: (patch: Record<string, unknown>) => Promise<any>
  listInputDevices: () => Promise<any[]>
  installWakeModel: (confirmed: boolean) => Promise<{ installed: boolean; message?: string }>
  startCodexAuth: () => Promise<{ started: boolean; message: string }>
  startWakeListening: () => Promise<any>
  startKwsTest: () => Promise<any>
  pauseWakeListening: () => Promise<any>
  openSoundSettings: () => Promise<void>
  onEvent: (listener: (event: any) => void) => () => void
}

const api = (): MikoApi | null => (typeof window === 'undefined' ? null : (window as any).homerailMiko || null)
const status = ref<any>(null)
const settings = ref<any>({ sensitivity: 'medium', silenceTimeoutSeconds: 60, wakeSoundEnabled: true, startAtLogin: true })
const nativeDevices = ref<any[]>([])
const browserDevices = ref<MediaDeviceInfo[]>([])
const selectedNativeId = ref('')
const selectedBrowserId = ref('')
const modelTermsConfirmed = ref(false)
const loadingDevices = ref(false)
const installingModel = ref(false)
const startingAuth = ref(false)
const startingListening = ref(false)
const testingWake = ref(false)
const wakeTestResult = ref('')
const error = ref('')
const authOutput = ref('')
let unsubscribe: (() => void) | null = null

const selectedNative = computed(() => nativeDevices.value.find(device => device.deviceId === selectedNativeId.value) || null)
const matchedBrowser = computed(() => {
  if (!selectedNative.value) return null
  return browserDevices.value.find(device => device.deviceId === selectedBrowserId.value)
    || browserDevices.value.find(device => device.kind === 'audioinput' && device.label.trim() === selectedNative.value.name.trim())
    || null
})
const canStart = computed(() => Boolean(
  selectedNative.value
  && matchedBrowser.value
  && status.value?.wakeModelInstalled
  && status.value?.codexLoggedIn
  && status.value?.codexLiveSupported
  && status.value?.codexLiveEffective,
))

async function refreshDevices(): Promise<void> {
  const bridge = api()
  if (!bridge) return
  loadingDevices.value = true
  error.value = ''
  try {
    nativeDevices.value = await bridge.listInputDevices()
    if (!selectedNativeId.value) selectedNativeId.value = nativeDevices.value.find(device => device.isDefaultInput)?.deviceId || nativeDevices.value[0]?.deviceId || ''
    await unlockBrowserDevices()
    if (!selectedBrowserId.value) {
      selectedBrowserId.value = browserDevices.value.find(device => device.label.trim() === selectedNative.value?.name.trim())?.deviceId
        || browserDevices.value[0]?.deviceId
        || ''
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loadingDevices.value = false
  }
}

async function unlockBrowserDevices(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前 macOS WebView 不支持麦克风采集')
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  stream.getTracks().forEach(track => track.stop())
  browserDevices.value = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput')
}

async function refreshStatus(): Promise<void> {
  const bridge = api()
  if (!bridge) return
  status.value = await bridge.getStatus()
  settings.value = await bridge.getSettings()
  if (settings.value?.inputDevice?.nativeDeviceId) selectedNativeId.value = settings.value.inputDevice.nativeDeviceId
  if (settings.value?.inputDevice?.browserDeviceId) selectedBrowserId.value = settings.value.inputDevice.browserDeviceId
}

async function installModel(): Promise<void> {
  const bridge = api()
  if (!bridge || !modelTermsConfirmed.value) return
  installingModel.value = true
  error.value = ''
  try {
    const result = await bridge.installWakeModel(true)
    if (!result.installed) throw new Error(result.message || 'Miko 离线模型下载失败')
    await refreshStatus()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    installingModel.value = false
  }
}

async function startAuth(): Promise<void> {
  const bridge = api()
  if (!bridge) return
  startingAuth.value = true
  error.value = ''
  try {
    const result = await bridge.startCodexAuth()
    if (!result.started && result.message) authOutput.value = result.message
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    startingAuth.value = false
  }
}

async function startListening(): Promise<void> {
  const bridge = api()
  if (!bridge || !selectedNative.value || !matchedBrowser.value || !settings.value) return
  startingListening.value = true
  error.value = ''
  try {
    await bridge.updateSettings({
      onboardingComplete: true,
      inputDevice: {
        label: selectedNative.value.name,
        nativeDeviceId: selectedNative.value.deviceId,
        browserDeviceId: matchedBrowser.value.deviceId,
        ...(matchedBrowser.value.groupId ? { groupId: matchedBrowser.value.groupId } : {}),
      },
    })
    await bridge.startWakeListening()
    emit('completed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    await bridge.updateSettings({ onboardingComplete: false }).catch(() => undefined)
  } finally {
    startingListening.value = false
  }
}

async function testWakeWord(): Promise<void> {
  const bridge = api()
  if (!bridge || !selectedNative.value || !matchedBrowser.value || !status.value?.wakeModelInstalled) return
  error.value = ''
  wakeTestResult.value = ''
  try {
    if (testingWake.value || status.value?.kwsTestMode) {
      await bridge.pauseWakeListening()
      testingWake.value = false
      wakeTestResult.value = '本地测试已停止'
      return
    }
    await bridge.updateSettings({
      inputDevice: {
        label: selectedNative.value.name,
        nativeDeviceId: selectedNative.value.deviceId,
        browserDeviceId: matchedBrowser.value.deviceId,
        ...(matchedBrowser.value.groupId ? { groupId: matchedBrowser.value.groupId } : {}),
      },
    })
    await bridge.startKwsTest()
    testingWake.value = true
    wakeTestResult.value = '请在当前麦克风前说“米可”'
  } catch (err) {
    testingWake.value = false
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function handleBridgeEvent(event: any): void {
  if (event?.type === 'status') {
    status.value = event.status
    settings.value = event.status.settings
    if (event.status.settings?.inputDevice?.nativeDeviceId) selectedNativeId.value = event.status.settings.inputDevice.nativeDeviceId
    if (event.status.settings?.inputDevice?.browserDeviceId) selectedBrowserId.value = event.status.settings.inputDevice.browserDeviceId
  }
  if (event?.type === 'codex-auth') authOutput.value = `${authOutput.value}\n${event.line}`.trim().slice(-4_000)
  if (event?.type === 'codex-auth-status' && event.state === 'completed') void refreshStatus()
  if (event?.type === 'kws-test-wake') {
    testingWake.value = false
    wakeTestResult.value = `已检测到“米可”（${new Date(event.detectedAt).toLocaleTimeString()}）`
  }
}

onMounted(async () => {
  const bridge = api()
  if (!bridge) return
  unsubscribe = bridge.onEvent(handleBridgeEvent)
  await refreshStatus()
  await refreshDevices()
})

onUnmounted(() => unsubscribe?.())
</script>

<template>
  <div class="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-5 backdrop-blur-sm">
    <section class="w-full max-w-2xl overflow-hidden rounded-2xl border border-[var(--hr-border)] bg-[var(--hr-panel)] text-[var(--hr-text-1)] shadow-2xl">
      <header class="border-b border-[var(--hr-border)] px-7 py-6">
        <p class="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--hr-accent)]">HomeRail Miko</p>
        <h1 class="text-2xl font-semibold">完成首次语音设置</h1>
        <p class="mt-2 text-sm text-[var(--hr-text-3)]">唤醒前的音频只在本机做“米可”检测；进入 GPT Live 后，语音会按 HomeRail 的现有规则发送。</p>
      </header>

      <div class="grid gap-5 px-7 py-6 md:grid-cols-2">
        <div class="space-y-5">
          <div>
            <div class="mb-2 flex items-center justify-between"><h2 class="font-medium">1. 选择输入麦克风</h2><button class="text-xs text-[var(--hr-accent)]" :disabled="loadingDevices" @click="refreshDevices">{{ loadingDevices ? '检测中…' : '重新检测' }}</button></div>
            <p class="mb-2 text-xs text-[var(--hr-text-3)]">MacBook 调试可使用内置麦克风；部署到 Mac mini 时再选择 USB 全向会议麦克风。</p>
            <select v-model="selectedNativeId" class="w-full rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 py-2 text-sm">
              <option value="" disabled>请选择输入设备</option>
              <option v-for="device in nativeDevices" :key="device.deviceId" :value="device.deviceId">{{ device.name }}</option>
            </select>
            <label class="mt-3 block text-xs text-[var(--hr-text-3)]">GPT Live 输入设备
              <select v-model="selectedBrowserId" class="mt-1 w-full rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 py-2 text-sm">
                <option value="" disabled>请选择浏览器输入设备</option>
                <option v-for="device in browserDevices" :key="device.deviceId" :value="device.deviceId">{{ device.label || '未命名输入设备' }}</option>
              </select>
            </label>
            <p class="mt-2 text-xs text-[var(--hr-text-3)]">KWS：{{ status?.kwsAudioLevel ? `${Math.round(status.kwsAudioLevel * 100)}%` : '等待输入' }}</p>
            <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--hr-surface-2)]"><div class="h-full bg-[var(--hr-accent)] transition-[width]" :style="{ width: `${Math.round((status?.kwsAudioLevel || 0) * 100)}%` }" /></div>
            <button class="mt-3 rounded-lg border border-[var(--hr-border)] px-3 py-2 text-sm disabled:opacity-45" :disabled="!selectedNative || !matchedBrowser || !status?.wakeModelInstalled" @click="testWakeWord">{{ testingWake || status?.kwsTestMode ? '停止本地唤醒测试' : '测试“米可”唤醒' }}</button>
            <p v-if="wakeTestResult" class="mt-2 text-xs text-[var(--hr-text-3)]">{{ wakeTestResult }}</p>
          </div>

          <div>
            <h2 class="mb-2 font-medium">2. 安装离线唤醒模型</h2>
            <label class="flex gap-2 text-xs text-[var(--hr-text-3)]"><input v-model="modelTermsConfirmed" type="checkbox" class="mt-0.5" />我确认从 sherpa-onnx 官方 Release 下载模型，并接受其来源条款。</label>
            <button class="mt-3 rounded-lg border border-[var(--hr-border)] px-3 py-2 text-sm disabled:opacity-45" :disabled="!modelTermsConfirmed || installingModel" @click="installModel">{{ installingModel ? '下载中…' : status?.wakeModelInstalled ? '模型已就绪' : '下载 Miko 模型' }}</button>
          </div>

          <div>
            <h2 class="mb-2 font-medium">3. Codex 登录</h2>
            <p class="text-xs text-[var(--hr-text-3)]">状态：{{ !status?.codexLoggedIn ? '未登录' : !status?.codexLiveSupported ? '已登录，但当前版本不支持 GPT Live' : status?.codexLiveEffective ? '已登录，GPT Live 配置已生效' : '已登录，请先在 HomeRail 中启用 Codex GPT Live' }}</p>
            <button class="mt-3 rounded-lg border border-[var(--hr-border)] px-3 py-2 text-sm disabled:opacity-45" :disabled="startingAuth || status?.codexLoggedIn" @click="startAuth">{{ startingAuth ? '启动中…' : status?.codexLoggedIn ? '已完成登录' : '开始设备登录' }}</button>
            <pre v-if="authOutput" class="mt-3 max-h-24 overflow-auto whitespace-pre-wrap rounded-lg bg-black/20 p-2 text-[11px] text-[var(--hr-text-3)]">{{ authOutput }}</pre>
          </div>
        </div>

        <div class="space-y-5">
          <div>
            <h2 class="mb-2 font-medium">4. 语音偏好</h2>
            <label class="flex items-center justify-between gap-3 text-sm">唤醒灵敏度<select v-model="settings.sensitivity" class="rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-2 py-1.5" @change="api()?.updateSettings({ sensitivity: settings.sensitivity })"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
            <label class="mt-3 flex items-center justify-between gap-3 text-sm">静默结束（秒）<input v-model.number="settings.silenceTimeoutSeconds" type="number" min="15" max="300" class="w-24 rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-2 py-1.5" @change="api()?.updateSettings({ silenceTimeoutSeconds: settings.silenceTimeoutSeconds })" /></label>
            <label class="mt-3 flex items-center gap-2 text-sm"><input v-model="settings.wakeSoundEnabled" type="checkbox" @change="api()?.updateSettings({ wakeSoundEnabled: settings.wakeSoundEnabled })" />唤醒时播放提示音</label>
            <label class="mt-3 flex items-center gap-2 text-sm"><input v-model="settings.startAtLogin" type="checkbox" @change="api()?.updateSettings({ startAtLogin: settings.startAtLogin })" />登录后自动启动</label>
          </div>

          <div>
            <h2 class="mb-2 font-medium">5. 声音输出</h2>
            <p class="text-xs text-[var(--hr-text-3)]">当前系统输出：{{ status?.systemOutputLabel || '检测中…' }}<span v-if="status?.systemOutputTransport === 'airplay'">（AirPlay/HomePod）</span></p>
            <p class="mt-1 text-xs text-[var(--hr-text-3)]">GPT Live 使用 macOS 当前默认输出。请在系统声音设置中选择 HomePod。</p>
            <button class="mt-3 rounded-lg border border-[var(--hr-border)] px-3 py-2 text-sm" @click="api()?.openSoundSettings()">打开声音设置</button>
          </div>

          <p v-if="error" class="rounded-lg border border-red-400/40 bg-red-500/10 p-3 text-xs text-red-200">{{ error }}</p>
          <button class="w-full rounded-lg bg-[var(--hr-accent)] px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45" :disabled="!canStart || startingListening" @click="startListening">{{ startingListening ? '正在启动监听…' : '开始监听“米可”' }}</button>
          <p v-if="!canStart" class="text-xs text-[var(--hr-text-3)]">完成麦克风匹配、模型下载和 Codex GPT Live 登录后即可开始。</p>
        </div>
      </div>
    </section>
  </div>
</template>
