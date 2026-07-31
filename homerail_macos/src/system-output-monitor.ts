import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type SystemOutputTransport = 'airplay' | 'builtin' | 'external' | 'unknown'

export interface SystemOutputSnapshot {
  label: string
  transport: SystemOutputTransport
}

type AudioItem = {
  _name?: unknown
  coreaudio_default_audio_output_device?: unknown
  coreaudio_default_audio_system_device?: unknown
  coreaudio_device_transport?: unknown
}

function itemIsDefaultOutput(item: AudioItem): boolean {
  return item.coreaudio_default_audio_output_device === 'spaudio_yes'
    || item.coreaudio_default_audio_system_device === 'spaudio_yes'
}

function resolveTransport(item: AudioItem): SystemOutputTransport {
  const transport = typeof item.coreaudio_device_transport === 'string'
    ? item.coreaudio_device_transport.toLowerCase()
    : ''
  const name = typeof item._name === 'string' ? item._name.toLowerCase() : ''
  if (transport.includes('airplay') || name.includes('airplay') || name.includes('homepod')) return 'airplay'
  if (transport.includes('builtin') || transport.includes('built-in')) return 'builtin'
  if (transport && !transport.includes('unknown')) return 'external'
  return 'unknown'
}

/** Parses the stable subset of system_profiler output used by the tray/UI. */
export function parseSystemOutputSnapshot(value: unknown): SystemOutputSnapshot {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const groups = Array.isArray(root.SPAudioDataType) ? root.SPAudioDataType : []
  const items = groups.flatMap(group => {
    if (!group || typeof group !== 'object') return []
    const candidate = group as Record<string, unknown>
    return Array.isArray(candidate._items) ? candidate._items : []
  }) as AudioItem[]
  // system_profiler can mark the built-in system device as default while the
  // actual output route (for example an AirPlay HomePod) is marked separately.
  const selected = items.find(item => item.coreaudio_default_audio_output_device === 'spaudio_yes')
    || items.find(itemIsDefaultOutput)
  if (!selected) return { label: '系统默认输出', transport: 'unknown' }
  const label = typeof selected._name === 'string' && selected._name.trim()
    ? selected._name.trim().slice(0, 200)
    : '系统默认输出'
  return { label, transport: resolveTransport(selected) }
}

export async function readSystemOutputSnapshot(): Promise<SystemOutputSnapshot> {
  if (process.platform !== 'darwin') return { label: '系统默认输出', transport: 'unknown' }
  try {
    const { stdout } = await execFileAsync('/usr/sbin/system_profiler', ['SPAudioDataType', '-json'], {
      encoding: 'utf8',
      timeout: 4_000,
      maxBuffer: 512 * 1024,
    })
    return parseSystemOutputSnapshot(JSON.parse(stdout))
  } catch {
    return { label: '系统默认输出', transport: 'unknown' }
  }
}
