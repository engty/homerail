import fs from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_FILES = 5

function redact(line: string): string {
  return line
    .replace(/(authorization|token|password|api[_-]?key|device[_-]?code)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .slice(0, 4_000)
}

export class DiagnosticLog {
  private readonly filePath: string

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, 'logs', 'miko.log')
  }

  append(stream: 'stdout' | 'stderr' | 'system', line: string): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
      this.rotateIfNeeded()
      const entry = `${new Date().toISOString()} [${stream}] ${redact(line)}\n`
      fs.appendFileSync(this.filePath, entry, { mode: 0o600 })
    } catch {
      // Diagnostics must never affect runtime or audio ownership.
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (fs.statSync(this.filePath).size < MAX_BYTES) return
    } catch {
      return
    }
    for (let index = MAX_FILES - 1; index >= 1; index -= 1) {
      const source = `${this.filePath}.${index}`
      const destination = `${this.filePath}.${index + 1}`
      if (fs.existsSync(source)) fs.renameSync(source, destination)
    }
    fs.renameSync(this.filePath, `${this.filePath}.1`)
  }
}
