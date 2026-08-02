import test from 'node:test'
import assert from 'node:assert/strict'
import { KWS_MAX_LINE_BYTES, encodeKwsMessage, parseKwsCommand, parseKwsEvent } from './protocol.js'

test('KWS command parser accepts only the versioned allowlist', () => {
  const encoded = encodeKwsMessage({ protocol: 1, generation: 3, type: 'configure', modelDir: '/tmp/model', deviceId: 'mic-1', sensitivity: 'medium' })
  assert.deepEqual(parseKwsCommand(encoded.trim()), {
    protocol: 1,
    generation: 3,
    type: 'configure',
    modelDir: '/tmp/model',
    deviceId: 'mic-1',
    sensitivity: 'medium',
  })
  assert.equal(parseKwsCommand(JSON.stringify({ protocol: 1, generation: 0, type: 'exec', command: 'rm -rf /' })), null)
  assert.equal(parseKwsCommand('x'.repeat(KWS_MAX_LINE_BYTES + 1)), null)
})

test('KWS event parser rejects malformed generations and accepts wake events', () => {
  assert.equal(parseKwsEvent(JSON.stringify({ protocol: 1, generation: -1, type: 'wake', keyword: 'MIKO', detectedAt: Date.now() })), null)
  assert.deepEqual(parseKwsEvent(JSON.stringify({ protocol: 1, generation: 2, type: 'wake', keyword: 'MIKO', detectedAt: 10 })), {
    protocol: 1,
    generation: 2,
    type: 'wake',
    keyword: 'MIKO',
    detectedAt: 10,
  })
})
