import test from 'node:test'
import assert from 'node:assert/strict'
import { KWS_KEYWORD_LINE } from './model-manager.js'

test('uses the Mandarin pronunciation for the Miko wake word', () => {
  assert.equal(KWS_KEYWORD_LINE, 'm ǐ k ě @MIKO')
})
