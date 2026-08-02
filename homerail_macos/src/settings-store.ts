import fs from 'node:fs'
import path from 'node:path'
import type { MikoSettingsPatch, MikoSettingsV1 } from './shared/types.js'

export const DEFAULT_MIKO_SETTINGS: MikoSettingsV1 = {
  schemaVersion: 1,
  onboardingComplete: false,
  startAtLogin: true,
  listeningEnabled: true,
  inputDevice: null,
  sensitivity: 'medium',
  silenceTimeoutSeconds: 60,
  wakeSoundEnabled: true,
}

function cloneDefaults(): MikoSettingsV1 {
  return {
    ...DEFAULT_MIKO_SETTINGS,
    inputDevice: null,
  }
}

function validInputDevice(value: unknown): MikoSettingsV1['inputDevice'] {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') throw new Error('inputDevice must be an object or null')
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.label !== 'string'
    || typeof candidate.nativeDeviceId !== 'string'
    || typeof candidate.browserDeviceId !== 'string'
  ) {
    throw new Error('inputDevice is missing a required identifier')
  }
  return {
    label: candidate.label.trim().slice(0, 200),
    nativeDeviceId: candidate.nativeDeviceId.trim().slice(0, 512),
    browserDeviceId: candidate.browserDeviceId.trim().slice(0, 512),
    ...(typeof candidate.groupId === 'string' && candidate.groupId.trim()
      ? { groupId: candidate.groupId.trim().slice(0, 512) }
      : {}),
  }
}

export function validateSettingsPatch(patch: MikoSettingsPatch): MikoSettingsPatch {
  if (!patch || typeof patch !== 'object') throw new Error('settings patch must be an object')
  const next: MikoSettingsPatch = {}
  if (patch.onboardingComplete !== undefined) {
    if (typeof patch.onboardingComplete !== 'boolean') throw new Error('onboardingComplete must be boolean')
    next.onboardingComplete = patch.onboardingComplete
  }
  if (patch.startAtLogin !== undefined) {
    if (typeof patch.startAtLogin !== 'boolean') throw new Error('startAtLogin must be boolean')
    next.startAtLogin = patch.startAtLogin
  }
  if (patch.listeningEnabled !== undefined) {
    if (typeof patch.listeningEnabled !== 'boolean') throw new Error('listeningEnabled must be boolean')
    next.listeningEnabled = patch.listeningEnabled
  }
  if (patch.inputDevice !== undefined) next.inputDevice = validInputDevice(patch.inputDevice)
  if (patch.sensitivity !== undefined) {
    if (!['low', 'medium', 'high'].includes(patch.sensitivity)) throw new Error('invalid sensitivity')
    next.sensitivity = patch.sensitivity
  }
  if (patch.silenceTimeoutSeconds !== undefined) {
    if (!Number.isInteger(patch.silenceTimeoutSeconds) || patch.silenceTimeoutSeconds < 15 || patch.silenceTimeoutSeconds > 300) {
      throw new Error('silenceTimeoutSeconds must be an integer between 15 and 300')
    }
    next.silenceTimeoutSeconds = patch.silenceTimeoutSeconds
  }
  if (patch.wakeSoundEnabled !== undefined) {
    if (typeof patch.wakeSoundEnabled !== 'boolean') throw new Error('wakeSoundEnabled must be boolean')
    next.wakeSoundEnabled = patch.wakeSoundEnabled
  }
  return next
}

function parseStoredSettings(value: unknown): MikoSettingsV1 {
  if (!value || typeof value !== 'object') return cloneDefaults()
  const candidate = value as Record<string, unknown>
  if (candidate.schemaVersion !== 1) return cloneDefaults()
  return {
    ...cloneDefaults(),
    ...validateSettingsPatch(candidate as MikoSettingsPatch),
    schemaVersion: 1,
  }
}

export class SettingsStore {
  private settings: MikoSettingsV1

  constructor(private readonly filePath: string) {
    this.settings = this.load()
  }

  get snapshot(): MikoSettingsV1 {
    return {
      ...this.settings,
      inputDevice: this.settings.inputDevice ? { ...this.settings.inputDevice } : null,
    }
  }

  update(patch: MikoSettingsPatch): MikoSettingsV1 {
    this.settings = {
      ...this.settings,
      ...validateSettingsPatch(patch),
      schemaVersion: 1,
    }
    this.persist()
    return this.snapshot
  }

  private load(): MikoSettingsV1 {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      return parseStoredSettings(JSON.parse(raw))
    } catch {
      return cloneDefaults()
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(temporaryPath, `${JSON.stringify(this.settings, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporaryPath, this.filePath)
  }
}
