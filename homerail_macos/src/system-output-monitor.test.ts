import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSystemOutputSnapshot } from './system-output-monitor.js'

test('selects the default AirPlay output and classifies it', () => {
  const snapshot = parseSystemOutputSnapshot({
    SPAudioDataType: [{
      _items: [
        { _name: 'MacBook Pro扬声器', coreaudio_default_audio_system_device: 'spaudio_yes', coreaudio_device_transport: 'coreaudio_device_type_builtin' },
        { _name: 'AirPlay', coreaudio_default_audio_output_device: 'spaudio_yes', coreaudio_device_transport: 'coreaudio_device_type_airplay' },
      ],
    }],
  })
  assert.deepEqual(snapshot, { label: 'AirPlay', transport: 'airplay' })
})

test('falls back safely when the default output is unavailable', () => {
  assert.deepEqual(parseSystemOutputSnapshot({ SPAudioDataType: [] }), {
    label: '系统默认输出',
    transport: 'unknown',
  })
})
