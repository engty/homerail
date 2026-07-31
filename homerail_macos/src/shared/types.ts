import type { KwsAudioDevice, KwsEvent } from '../kws/protocol.js'

export type MikoLifecycleState =
  | 'setup-required'
  | 'paused'
  | 'listening'
  | 'wake-detected'
  | 'live-connecting'
  | 'live-listening'
  | 'user-speaking'
  | 'assistant-speaking'
  | 'reconnecting'
  | 'ending'
  | 'error'

export type KwsSensitivity = 'low' | 'medium' | 'high'

export type RuntimeState = 'stopped' | 'starting' | 'ready' | 'unavailable' | 'error'

export interface MikoSettingsV1 {
  schemaVersion: 1
  onboardingComplete: boolean
  startAtLogin: boolean
  listeningEnabled: boolean
  inputDevice: {
    label: string
    nativeDeviceId: string
    browserDeviceId: string
    groupId?: string
  } | null
  sensitivity: KwsSensitivity
  silenceTimeoutSeconds: number
  wakeSoundEnabled: boolean
}

export interface RuntimeStatus {
  state: RuntimeState
  managerUrl: string
  uiUrl: string
  message?: string
  pid?: number
}

export interface MikoAppStatus {
  lifecycle: MikoLifecycleState
  runtime: RuntimeStatus
  settings: MikoSettingsV1
  microphonePermission: 'not-determined' | 'denied' | 'granted' | 'restricted'
  selectedInputLabel?: string
  systemOutputLabel?: string
  systemOutputTransport?: 'airplay' | 'builtin' | 'external' | 'unknown'
  codexLoggedIn: boolean
  codexLiveSupported: boolean
  codexLiveEffective: boolean
  liveSessionActive: boolean
  kwsState: 'unavailable' | 'paused' | 'listening' | 'wake-detected' | 'error'
  kwsTestMode: boolean
  kwsAudioLevel: number
  inputDevices: KwsAudioDevice[]
  wakeModelInstalled: boolean
}

export type MikoEvent =
  | { type: 'status'; status: MikoAppStatus }
  | { type: 'runtime-log'; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'kws'; event: KwsEvent }
  | { type: 'kws-test-wake'; detectedAt: number }
  | { type: 'live-input-lease-expired' }
  | { type: 'conversation-end-requested' }
  | { type: 'settings-requested' }
  | { type: 'codex-auth'; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'codex-auth-status'; state: 'started' | 'completed' | 'failed'; code?: number | null; signal?: string | null }
  | { type: 'runtime-error'; message: string }

export type MikoSettingsPatch = Partial<Omit<MikoSettingsV1, 'schemaVersion'>>

export interface MikoDesktopApi {
  getStatus(): Promise<MikoAppStatus>
  getSettings(): Promise<MikoSettingsV1>
  updateSettings(patch: MikoSettingsPatch): Promise<MikoSettingsV1>
  setListening(enabled: boolean): Promise<MikoAppStatus>
  listInputDevices(): Promise<KwsAudioDevice[]>
  installWakeModel(confirmedSourceTerms: boolean): Promise<{ installed: boolean; modelDir?: string; message?: string }>
  startWakeListening(): Promise<MikoAppStatus>
  startKwsTest(): Promise<MikoAppStatus>
  setLiveSessionActive(active: boolean): Promise<MikoAppStatus>
  renewLiveSessionLease(): Promise<MikoAppStatus>
  pauseWakeListening(): Promise<MikoAppStatus>
  endConversation(): Promise<MikoAppStatus>
  startCodexAuth(): Promise<{ started: boolean; message: string }>
  openHomeRail(): Promise<void>
  openSoundSettings(): Promise<void>
  showWindow(): Promise<void>
  quit(): Promise<void>
  onEvent(listener: (event: MikoEvent) => void): () => void
}

declare global {
  interface Window {
    homerailMiko: MikoDesktopApi
  }
}
