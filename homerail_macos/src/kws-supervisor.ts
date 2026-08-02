import fs from 'node:fs'
import path from 'node:path'
import { ChildProcessSupervisor } from './child-process-supervisor.js'
import type { KwsSensitivity } from './shared/types.js'
import {
  encodeKwsMessage,
  parseKwsEvent,
  type KwsAudioDevice,
  type KwsCommand,
  type KwsEvent,
} from './kws/protocol.js'

export interface KwsSupervisorOptions {
  appPath: string
  isPackaged: boolean
  onEvent: (event: KwsEvent) => void
  onLog: (stream: 'stdout' | 'stderr', line: string) => void
}

type PendingEvent = {
  type: KwsEvent['type']
  resolve: (event: KwsEvent) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class KwsSupervisor {
  private process: ChildProcessSupervisor | null = null
  private generation = 0
  private pending: PendingEvent[] = []

  constructor(private readonly options: KwsSupervisorOptions) {}

  get running(): boolean {
    return this.process?.running ?? false
  }

  async listDevices(): Promise<KwsAudioDevice[]> {
    await this.ensureProcess()
    const generation = this.nextGeneration()
    const event = await this.sendAndWait({ type: 'list-devices', protocol: 1, generation }, 'devices')
    return event.type === 'devices' ? event.devices : []
  }

  async configure(modelDir: string, deviceId: string, sensitivity: KwsSensitivity): Promise<void> {
    await this.ensureProcess()
    const generation = this.nextGeneration()
    await this.sendAndWait({ type: 'configure', protocol: 1, generation, modelDir, deviceId, sensitivity }, 'ready')
  }

  async startListening(): Promise<void> {
    await this.ensureProcess()
    const generation = this.nextGeneration()
    await this.sendAndWait({ type: 'start', protocol: 1, generation }, 'listening')
  }

  async pause(): Promise<void> {
    if (!this.process?.running) return
    const generation = this.nextGeneration()
    await this.sendAndWait({ type: 'pause', protocol: 1, generation }, 'paused')
  }

  async stop(): Promise<void> {
    const process = this.process
    this.process = null
    if (!process) return
    const generation = this.nextGeneration()
    process.send(encodeKwsMessage({ type: 'shutdown', protocol: 1, generation }))
    await process.stop()
    this.rejectPending(new Error('KWS service stopped'))
  }

  private async ensureProcess(): Promise<void> {
    if (this.process?.running) return
    const sidecarPath = this.resolveSidecarPath()
    if (!fs.existsSync(sidecarPath)) throw new Error(`KWS sidecar is missing: ${sidecarPath}`)
    const nodeBinary = process.env.HOMERAIL_NODE_BIN
      || (this.options.isPackaged ? path.join(process.resourcesPath, 'homerail-runtime', 'node', 'bin', 'node') : process.execPath)
    const nodePath = path.dirname(nodeBinary)
    const resourcesNodeModules = this.options.isPackaged
      ? path.join(process.resourcesPath, 'miko-kws', 'node_modules')
      : path.resolve(this.options.appPath, 'node_modules')
    const child = new ChildProcessSupervisor({
      label: 'Miko wake service',
      command: nodeBinary,
      args: [sidecarPath],
      cwd: path.dirname(sidecarPath),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: this.options.isPackaged ? undefined : '1',
        PATH: `${nodePath}:${process.env.PATH || ''}`,
        NODE_PATH: resourcesNodeModules,
      },
    }, {
      onLine: (stream, line) => {
        if (stream === 'stdout') {
          const event = parseKwsEvent(line)
          if (event) {
            if (event.generation >= this.generation) this.options.onEvent(event)
            this.resolvePending(event)
          } else {
            this.options.onLog(stream, line.slice(0, 4_000))
          }
        } else {
          this.options.onLog(stream, line.slice(0, 4_000))
        }
      },
      onError: error => this.options.onLog('stderr', error.message),
      onExit: (code, signal) => {
        this.rejectPending(new Error(`KWS service exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`))
      },
    })
    this.process = child
    child.start()
  }

  private resolveSidecarPath(): string {
    return this.options.isPackaged
      ? path.join(process.resourcesPath, 'miko-kws', 'kws-sidecar.js')
      : path.join(this.options.appPath, 'dist', 'kws', 'kws-sidecar.js')
  }

  private nextGeneration(): number {
    this.generation += 1
    return this.generation
  }

  private sendAndWait(command: KwsCommand, type: KwsEvent['type']): Promise<KwsEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter(item => item.resolve !== resolve)
        reject(new Error(`Timed out waiting for KWS ${type}`))
      }, 8_000)
      this.pending.push({ type, resolve, reject, timer })
      if (!this.process?.send(encodeKwsMessage(command))) {
        clearTimeout(timer)
        this.pending = this.pending.filter(item => item.resolve !== resolve)
        reject(new Error('KWS service is not accepting commands'))
      }
    })
  }

  private resolvePending(event: KwsEvent): void {
    const index = this.pending.findIndex(item => item.type === event.type && event.generation >= this.generation)
    if (index < 0) return
    const [pending] = this.pending.splice(index, 1)
    clearTimeout(pending.timer)
    pending.resolve(event)
  }

  private rejectPending(error: Error): void {
    const pending = this.pending.splice(0)
    for (const item of pending) {
      clearTimeout(item.timer)
      item.reject(error)
    }
  }
}
