import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const KWS_MODEL_NAME = 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20'
export const KWS_MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${KWS_MODEL_NAME}.tar.bz2`
export const KWS_MODEL_SHA256 = '68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6'
export const KWS_KEYWORD_LINE = 'M IY1 K OW0 @MIKO'

const REQUIRED_MODEL_FILES = [
  'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx',
  'decoder-epoch-13-avg-2-chunk-16-left-64.onnx',
  'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx',
  'tokens.txt',
  'en.phone',
]

export interface KwsModelStatus {
  installed: boolean
  modelDir: string
  archiveSha256: string
  requiresSourceTermsConfirmation: boolean
}

export interface EnsureKwsModelOptions {
  allowDownload: boolean
  confirmedSourceTerms: boolean
}

export class KwsModelManager {
  readonly modelDir: string

  constructor(private readonly rootDir: string) {
    this.modelDir = path.join(rootDir, KWS_MODEL_NAME)
  }

  status(): KwsModelStatus {
    const metadataPath = path.join(this.modelDir, 'miko-model.json')
    let archiveSha256 = ''
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as Record<string, unknown>
      if (typeof metadata.archiveSha256 === 'string') archiveSha256 = metadata.archiveSha256
    } catch {
      // A missing or malformed marker is treated as an incomplete install.
    }
    return {
      installed: this.hasRequiredFiles() && archiveSha256 === KWS_MODEL_SHA256,
      modelDir: this.modelDir,
      archiveSha256,
      // The upstream archive has no bundled license file, so it is never silently redistributed.
      requiresSourceTermsConfirmation: true,
    }
  }

  async ensureInstalled(options: EnsureKwsModelOptions): Promise<KwsModelStatus> {
    const current = this.status()
    if (current.installed) return current
    if (!options.allowDownload) throw new Error('Miko wake model is not installed')
    if (!options.confirmedSourceTerms) {
      throw new Error('Confirm the sherpa-onnx model source terms before downloading the wake model')
    }

    await fsp.mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    const temporaryRoot = await fsp.mkdtemp(path.join(this.rootDir, '.download-'))
    const archivePath = path.join(temporaryRoot, `${KWS_MODEL_NAME}.tar.bz2`)
    try {
      const archive = await downloadArchive(KWS_MODEL_URL)
      if (archive.length > 100 * 1024 * 1024) throw new Error('Miko wake model archive is unexpectedly large')
      const digest = createHash('sha256').update(archive).digest('hex')
      if (digest !== KWS_MODEL_SHA256) throw new Error(`Miko wake model digest mismatch: ${digest}`)
      await fsp.writeFile(archivePath, archive, { mode: 0o600 })
      await validateArchiveEntries(archivePath)
      await runTarExtract(archivePath, temporaryRoot)

      const extractedDir = path.join(temporaryRoot, KWS_MODEL_NAME)
      if (!(await isDirectory(extractedDir))) throw new Error('Miko wake model archive has an unexpected layout')
      for (const file of REQUIRED_MODEL_FILES) {
        if (!(await isFile(path.join(extractedDir, file)))) throw new Error(`Miko wake model is missing ${file}`)
      }
      await fsp.writeFile(path.join(extractedDir, 'keywords.txt'), `${KWS_KEYWORD_LINE}\n`, { mode: 0o600 })
      await fsp.writeFile(
        path.join(extractedDir, 'miko-model.json'),
        `${JSON.stringify({ model: KWS_MODEL_NAME, archiveSha256: KWS_MODEL_SHA256, keyword: 'MIKO' }, null, 2)}\n`,
        { mode: 0o600 },
      )
      await fsp.rm(this.modelDir, { recursive: true, force: true })
      await fsp.rename(extractedDir, this.modelDir)
      return this.status()
    } finally {
      await fsp.rm(temporaryRoot, { recursive: true, force: true })
    }
  }

  private hasRequiredFiles(): boolean {
    try {
      return REQUIRED_MODEL_FILES.every(file => fs.statSync(path.join(this.modelDir, file)).isFile())
        && fs.statSync(path.join(this.modelDir, 'keywords.txt')).isFile()
    } catch {
      return false
    }
  }
}

async function downloadArchive(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Miko wake model download failed with HTTP ${response.status}`)
  const data = Buffer.from(await response.arrayBuffer())
  return data
}

async function validateArchiveEntries(archivePath: string): Promise<void> {
  const output = await runCommand('tar', ['-tjf', archivePath])
  const entries = output.split(/\r?\n/).map(entry => entry.trim()).filter(Boolean)
  for (const entry of entries) {
    if (path.isAbsolute(entry) || entry.split('/').includes('..')) throw new Error('Miko wake model archive contains an unsafe path')
  }
}

async function runTarExtract(archivePath: string, destination: string): Promise<void> {
  await runCommand('tar', ['-xjf', archivePath, '-C', destination])
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} failed (${code ?? 'unknown'}): ${stderr.slice(0, 500)}`))
    })
  })
}

async function isFile(filePath: string): Promise<boolean> {
  try { return (await fsp.stat(filePath)).isFile() } catch { return false }
}

async function isDirectory(directoryPath: string): Promise<boolean> {
  try { return (await fsp.stat(directoryPath)).isDirectory() } catch { return false }
}
