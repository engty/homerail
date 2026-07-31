import test from 'node:test'
import assert from 'node:assert/strict'
import { outputChangeNotice, parseSystemOutputSnapshot, systemOutputChanged } from './system-output-monitor.js'

test('classifies output route changes without assuming HomePod takeover', () => {
  const homePod = { label: '客厅', transport: 'airplay' as const }
  const builtIn = { label: 'MacBook Pro扬声器', transport: 'builtin' as const }
  assert.equal(systemOutputChanged(homePod, homePod), false)
  assert.equal(systemOutputChanged(homePod, builtIn), true)
  assert.equal(outputChangeNotice(builtIn, homePod), 'AirPlay 输出已切换到“客厅”')
  assert.equal(outputChangeNotice(homePod, builtIn), 'HomePod 输出不可用，当前使用“MacBook Pro扬声器”')
  assert.equal(outputChangeNotice(builtIn, { label: 'USB 音箱', transport: 'external' }), '系统输出已切换到“USB 音箱”')
})

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
