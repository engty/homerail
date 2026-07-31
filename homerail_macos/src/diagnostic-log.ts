import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_FILES = 5
const MAX_EXPORT_BYTES = 8 * 1024 * 1024
const HOME_PATH = os.homedir()

export type DiagnosticExportContext = Record<string, string | number | boolean | null | undefined>

export function redactDiagnosticLine(line: string): string {
  const redacted = line
    .replace(/(authorization|token|password|api[_-]?key|device[_-]?code)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/(["']?(?:authorization|token|password|api[_-]?key|device[_-]?code)["']?\s*[:=]\s*["']?)([^"',}\s]+)(["']?)/gi, '$1[redacted]$3')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\/Users\/[^/\s]+/g, '/Users/[user]')
    .slice(0, 4_000)
  return HOME_PATH && HOME_PATH !== path.parse(HOME_PATH).root
    ? redacted.replaceAll(HOME_PATH, '~')
    : redacted
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
      const entry = `${new Date().toISOString()} [${stream}] ${redactDiagnosticLine(line)}\n`
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

  exportTo(destination: string, context: DiagnosticExportContext = {}): void {
    const sections: string[] = [
      'HomeRail Miko diagnostics',
      `generatedAt=${new Date().toISOString()}`,
    ]
    for (const [key, value] of Object.entries(context)) {
      if (value === undefined || value === null) continue
      sections.push(redactDiagnosticLine(`${key}=${String(value)}`))
    }
    sections.push('', 'Logs (credentials and credential-shaped values redacted):')

    let output = `${sections.join('\n')}\n`
    for (const logPath of this.logPaths()) {
      if (!fs.existsSync(logPath)) continue
      const header = `\n--- ${path.basename(logPath)} ---\n`
      if (Buffer.byteLength(output + header, 'utf8') >= MAX_EXPORT_BYTES) break
      output += header
      let source: string
      try {
        source = fs.readFileSync(logPath, 'utf8')
      } catch {
        continue
      }
      for (const line of source.split(/\r?\n/)) {
        if (!line) continue
        const redacted = `${redactDiagnosticLine(line)}\n`
        if (Buffer.byteLength(output + redacted, 'utf8') > MAX_EXPORT_BYTES) break
        output += redacted
      }
      if (Buffer.byteLength(output, 'utf8') >= MAX_EXPORT_BYTES) break
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    fs.writeFileSync(destination, output, { encoding: 'utf8', mode: 0o600 })
    try { fs.chmodSync(destination, 0o600) } catch { /* best effort on unusual filesystems */ }
  }

  private logPaths(): string[] {
    return [this.filePath, ...Array.from({ length: MAX_FILES }, (_, index) => `${this.filePath}.${index + 1}`)]
  }
}
