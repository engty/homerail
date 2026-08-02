import assert from 'node:assert/strict'
import test from 'node:test'
import { LiveInputLease } from './live-input-lease.js'

test('live input lease renews before its deadline', async () => {
  let expired = 0
  const lease = new LiveInputLease(() => { expired += 1 }, 100)
  lease.acquire()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(lease.renew(), true)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(lease.isActive, true)
  assert.equal(expired, 0)
  lease.release()
})

test('live input lease expires once and never re-arms itself', async () => {
  let expired = 0
  const lease = new LiveInputLease(() => { expired += 1 }, 50)
  lease.acquire()
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(lease.isActive, false)
  assert.equal(expired, 1)
  assert.equal(lease.renew(), false)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(expired, 1)
})

test('releasing a live input lease suppresses expiry', async () => {
  let expired = 0
  const lease = new LiveInputLease(() => { expired += 1 }, 50)
  lease.acquire()
  lease.release()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(lease.isActive, false)
  assert.equal(expired, 0)
})
