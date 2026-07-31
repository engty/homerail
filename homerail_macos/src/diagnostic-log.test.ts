import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DiagnosticLog } from './diagnostic-log.js'

test('diagnostic log redacts credential-shaped values and rotates large files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homerail-miko-log-'))
  try {
    const log = new DiagnosticLog(root)
    log.append('stderr', 'authorization: bearer-secret token=my-token')
    const file = path.join(root, 'logs', 'miko.log')
    const content = fs.readFileSync(file, 'utf8')
    assert.match(content, /authorization[=:]\[redacted\]/i)
    assert.doesNotMatch(content, /bearer-secret|my-token/)
    for (let index = 0; index < 550; index += 1) log.append('system', 'x'.repeat(4_000))
    log.append('system', 'after-rotation')
    assert.equal(fs.existsSync(`${file}.1`), true)
    assert.match(fs.readFileSync(file, 'utf8'), /after-rotation/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
