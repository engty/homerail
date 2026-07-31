import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SettingsStore } from './settings-store.js'

test('settings store writes validated defaults and reloads them', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'homerail-miko-settings-'))
  const filePath = path.join(directory, 'settings.json')
  try {
    const first = new SettingsStore(filePath)
    assert.equal(first.snapshot.silenceTimeoutSeconds, 60)
    assert.equal(first.snapshot.onboardingComplete, false)

    first.update({
      onboardingComplete: true,
      sensitivity: 'high',
      silenceTimeoutSeconds: 120,
      inputDevice: {
        label: 'USB Conference Mic',
        nativeDeviceId: 'native-1',
        browserDeviceId: 'browser-1',
      },
    })

    const reloaded = new SettingsStore(filePath)
    assert.equal(reloaded.snapshot.onboardingComplete, true)
    assert.equal(reloaded.snapshot.sensitivity, 'high')
    assert.equal(reloaded.snapshot.silenceTimeoutSeconds, 120)
    assert.equal(reloaded.snapshot.inputDevice?.label, 'USB Conference Mic')
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('settings store rejects unsafe timeout values and invalid sensitivity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'homerail-miko-settings-'))
  try {
    const store = new SettingsStore(path.join(directory, 'settings.json'))
    assert.throws(() => store.update({ silenceTimeoutSeconds: 14 }), /between 15 and 300/)
    assert.throws(() => store.update({ sensitivity: 'unknown' as 'low' }), /invalid sensitivity/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
