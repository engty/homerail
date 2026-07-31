import assert from 'node:assert/strict'
import test from 'node:test'
import { isAllowedMediaPermission, isTrustedLocalAppUrl } from './security-policy.js'

test('trusts only loopback HTTP origins for the embedded HomeRail UI', () => {
  assert.equal(isTrustedLocalAppUrl('http://127.0.0.1:29193/'), true)
  assert.equal(isTrustedLocalAppUrl('http://localhost:29193/agent'), true)
  assert.equal(isTrustedLocalAppUrl('https://localhost:29193/'), false)
  assert.equal(isTrustedLocalAppUrl('http://192.168.1.20:29193/'), false)
  assert.equal(isTrustedLocalAppUrl('file:///tmp/index.html'), false)
  assert.equal(isTrustedLocalAppUrl('not a URL'), false)
})

test('allows only local media permission requests', () => {
  assert.equal(isAllowedMediaPermission('media', 'http://127.0.0.1:29193/'), true)
  assert.equal(isAllowedMediaPermission('notifications', 'http://127.0.0.1:29193/'), false)
  assert.equal(isAllowedMediaPermission('media', 'https://localhost:29193/'), false)
  assert.equal(isAllowedMediaPermission('media', 'https://example.com/'), false)
})
