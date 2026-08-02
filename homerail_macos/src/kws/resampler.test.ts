import test from 'node:test'
import assert from 'node:assert/strict'
import { mixToMono, rmsLevel } from './resampler.js'

test('mixToMono averages interleaved channels without writing audio to disk', () => {
  assert.deepEqual(Array.from(mixToMono(new Float32Array([1, -1, 0.5, 0.5]), 2)), [0, 0.5])
})

test('rmsLevel returns a bounded local level meter', () => {
  assert.equal(rmsLevel(new Float32Array()), 0)
  assert.equal(rmsLevel(new Float32Array([1, -1])), 1)
  assert.ok(rmsLevel(new Float32Array([0.5, 0.5])) > 0.49)
})
