import type { KwsSensitivity } from '../shared/types.js'

export const KWS_PROTOCOL_VERSION = 1
export const KWS_MAX_LINE_BYTES = 8_192

export interface KwsAudioDevice {
  name: string
  hostId: string
  deviceId: string
  isDefaultInput: boolean
  supportedInputConfigs: Array<{
    minSampleRate: number
    maxSampleRate: number
    channels: number
    sampleFormat: 'i16' | 'u16' | 'f32'
  }>
}

interface KwsMessageBase {
  protocol: typeof KWS_PROTOCOL_VERSION
  generation: number
}

export type KwsCommand =
  | (KwsMessageBase & { type: 'list-devices' })
  | (KwsMessageBase & {
    type: 'configure'
    modelDir: string
    deviceId: string
    sensitivity: KwsSensitivity
  })
  | (KwsMessageBase & { type: 'start' })
  | (KwsMessageBase & { type: 'pause' })
  | (KwsMessageBase & { type: 'shutdown' })
  | (KwsMessageBase & { type: 'ping' })

export type KwsEvent =
  | (KwsMessageBase & { type: 'devices'; devices: KwsAudioDevice[] })
  | (KwsMessageBase & { type: 'ready'; deviceId: string; sampleRate: number })
  | (KwsMessageBase & { type: 'listening'; deviceId: string; sampleRate: number })
  | (KwsMessageBase & { type: 'paused'; reason: 'requested' | 'device-lost' | 'wake' })
  | (KwsMessageBase & { type: 'wake'; keyword: 'MIKO'; detectedAt: number })
  | (KwsMessageBase & { type: 'audio-level'; rms: number })
  | (KwsMessageBase & { type: 'device-lost'; deviceId: string })
  | (KwsMessageBase & { type: 'device-restored'; deviceId: string })
  | (KwsMessageBase & { type: 'error'; message: string })
  | (KwsMessageBase & { type: 'pong' })

export function encodeKwsMessage(message: KwsCommand | KwsEvent): string {
  return `${JSON.stringify(message)}\n`
}

export function parseKwsCommand(line: string): KwsCommand | null {
  if (Buffer.byteLength(line, 'utf8') > KWS_MAX_LINE_BYTES) return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (candidate.protocol !== KWS_PROTOCOL_VERSION || typeof candidate.generation !== 'number' || !Number.isSafeInteger(candidate.generation) || candidate.generation < 0) return null
  if (typeof candidate.type !== 'string') return null
  const generation = candidate.generation as number
  const base = {
    protocol: KWS_PROTOCOL_VERSION as typeof KWS_PROTOCOL_VERSION,
    generation,
  }
  switch (candidate.type) {
    case 'list-devices':
    case 'start':
    case 'pause':
    case 'shutdown':
    case 'ping':
      return { ...base, type: candidate.type }
    case 'configure':
      if (
        typeof candidate.modelDir !== 'string'
        || typeof candidate.deviceId !== 'string'
        || !['low', 'medium', 'high'].includes(String(candidate.sensitivity))
      ) return null
      return {
        ...base,
        type: 'configure',
        modelDir: candidate.modelDir,
        deviceId: candidate.deviceId,
        sensitivity: candidate.sensitivity as KwsSensitivity,
      }
    default:
      return null
  }
}

export function parseKwsEvent(line: string): KwsEvent | null {
  if (Buffer.byteLength(line, 'utf8') > KWS_MAX_LINE_BYTES) return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (candidate.protocol !== KWS_PROTOCOL_VERSION || typeof candidate.generation !== 'number' || !Number.isSafeInteger(candidate.generation) || candidate.generation < 0) return null
  if (typeof candidate.type !== 'string') return null
  switch (candidate.type) {
    case 'pong':
      return value as KwsEvent
    case 'devices':
      if (!Array.isArray(candidate.devices)) return null
      return value as KwsEvent
    case 'ready':
    case 'listening':
      if (typeof candidate.deviceId !== 'string' || typeof candidate.sampleRate !== 'number' || !Number.isSafeInteger(candidate.sampleRate)) return null
      return value as KwsEvent
    case 'paused':
      if (!['requested', 'device-lost', 'wake'].includes(String(candidate.reason))) return null
      return value as KwsEvent
    case 'wake':
      if (candidate.keyword !== 'MIKO' || typeof candidate.detectedAt !== 'number') return null
      return value as KwsEvent
    case 'audio-level':
      if (typeof candidate.rms !== 'number' || !Number.isFinite(candidate.rms) || candidate.rms < 0 || candidate.rms > 1) return null
      return value as KwsEvent
    case 'device-lost':
    case 'device-restored':
      if (typeof candidate.deviceId !== 'string') return null
      return value as KwsEvent
    case 'error':
      if (typeof candidate.message !== 'string' || candidate.message.length > 500) return null
      return value as KwsEvent
    default:
      return null
  }
}
