import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcessSupervisor } from './child-process-supervisor.js'
import { ChildProcessSupervisor as ProcessSupervisor } from './child-process-supervisor.js'
import type { RuntimeStatus } from './shared/types.js'

export interface RuntimeSupervisorOptions {
  appPath: string
  isPackaged: boolean
  userDataPath: string
  onStatus: (status: RuntimeStatus) => void
  onLog: (stream: 'stdout' | 'stderr', line: string) => void
}

const DEFAULT_MANAGER_PORT = 29191
const DEFAULT_UI_HTTPS_PORT = 29192
const DEFAULT_UI_HTTP_PORT = 29193

async function endpointReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(750) })
    return response.ok
  } catch {
    return false
  }
}

export class RuntimeSupervisor {
  private process: ChildProcessSupervisor | null = null
  private status: RuntimeStatus
  private pollTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private restartCount = 0
  private stopping = false

  readonly managerPort = Number(process.env.HOMERAIL_MIKO_MANAGER_PORT || DEFAULT_MANAGER_PORT)
  readonly uiHttpsPort = Number(process.env.HOMERAIL_MIKO_UI_HTTPS_PORT || DEFAULT_UI_HTTPS_PORT)
  readonly uiHttpPort = Number(process.env.HOMERAIL_MIKO_UI_HTTP_PORT || DEFAULT_UI_HTTP_PORT)
  readonly managerUrl = `http://127.0.0.1:${this.managerPort}`
  readonly uiUrl = `http://127.0.0.1:${this.uiHttpPort}`

  constructor(private readonly options: RuntimeSupervisorOptions) {
    this.status = {
      state: 'stopped',
      managerUrl: this.managerUrl,
      uiUrl: this.uiUrl,
    }
  }

  get snapshot(): RuntimeStatus {
    return { ...this.status }
  }

  async start(): Promise<void> {
    if (this.status.state === 'starting' || this.status.state === 'ready') return
    this.stopping = false
    const paths = this.resolvePaths()
    if (!fs.existsSync(paths.cliPath)) {
      this.publish({
        state: 'unavailable',
        managerUrl: this.managerUrl,
        uiUrl: this.uiUrl,
        message: `HomeRail CLI runtime is missing: ${paths.cliPath}`,
      })
      return
    }
    this.publish({ state: 'starting', managerUrl: this.managerUrl, uiUrl: this.uiUrl })
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    const nodeBinary = this.resolveNodeBinary(paths)
    const env = this.runtimeEnv(paths)
    this.process = new ProcessSupervisor({
      label: 'HomeRail runtime',
      command: nodeBinary,
      args: [paths.cliPath, 'start', '--ui', '--no-build-worker-image', '--host', '127.0.0.1', '--ui-host', '127.0.0.1', '--ui-port', String(this.uiHttpsPort)],
      cwd: paths.runtimeRoot,
      env,
    }, {
      onLine: (stream, line) => this.options.onLog(stream, line.slice(0, 4_000)),
      onError: error => {
        this.publish({ state: 'error', managerUrl: this.managerUrl, uiUrl: this.uiUrl, message: error.message })
      },
      onExit: (code, signal) => {
        if (this.stopping || this.status.state === 'ready') return
        setTimeout(() => {
          void this.pollReady().then(() => {
            if (this.stopping || this.status.state === 'ready') return
            this.publish({
              state: 'error',
              managerUrl: this.managerUrl,
              uiUrl: this.uiUrl,
              message: `HomeRail runtime exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`,
            })
            this.scheduleRestart()
          })
        }, 500)
      },
    })
    this.process.start()
    this.pollTimer = setInterval(() => void this.pollReady(), 1_000)
    await this.pollReady()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.pollTimer = null
    this.restartTimer = null
    await this.process?.stop()
    await this.stopServices()
    this.process = null
    this.publish({ state: 'stopped', managerUrl: this.managerUrl, uiUrl: this.uiUrl })
  }

  private async pollReady(): Promise<void> {
    if (this.stopping) return
    const [managerReady, uiReady] = await Promise.all([
      endpointReady(`${this.managerUrl}/health`),
      endpointReady(this.uiUrl),
    ])
    if (managerReady && uiReady) {
      if (this.status.state !== 'ready') {
        this.restartCount = 0
        this.publish({
          state: 'ready',
          managerUrl: this.managerUrl,
          uiUrl: this.uiUrl,
          pid: this.process?.pid,
        })
      }
      return
    }
    if (this.status.state === 'ready') {
      this.publish({
        state: 'error',
        managerUrl: this.managerUrl,
        uiUrl: this.uiUrl,
        message: 'HomeRail runtime health check failed',
      })
      this.scheduleRestart()
    }
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer || this.restartCount >= 3) return
    const delay = Math.min(8_000, 1_000 * (2 ** this.restartCount))
    this.restartCount += 1
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.stopServices().finally(() => {
        if (!this.stopping) void this.start()
      })
    }, delay)
  }

  private async stopServices(): Promise<void> {
    const paths = this.resolvePaths()
    if (!fs.existsSync(paths.cliPath)) return
    const nodeBinary = this.resolveNodeBinary(paths)
    await this.runCliCommand(nodeBinary, paths.cliPath, ['runtime', 'stop'], this.runtimeEnv(paths))
  }

  private runCliCommand(
    nodeBinary: string,
    cliPath: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    return new Promise(resolve => {
      const child = spawn(nodeBinary, [cliPath, ...args], {
        cwd: path.dirname(path.dirname(cliPath)),
        env,
        stdio: 'ignore',
        windowsHide: true,
      })
      const timer = setTimeout(() => {
        if (!child.killed) child.kill('SIGTERM')
        resolve()
      }, 15_000)
      child.once('error', () => {
        clearTimeout(timer)
        resolve()
      })
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private resolveNodeBinary(paths: { runtimeRoot: string }): string {
    return process.env.HOMERAIL_NODE_BIN
      || (this.options.isPackaged ? path.join(paths.runtimeRoot, 'node', 'bin', 'node') : 'node')
  }

  private runtimeEnv(paths: { runtimeRoot: string; uiDist: string }): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      HOMERAIL_HOME: path.join(this.options.userDataPath, 'homerail'),
      HOMERAIL_MANAGER_HOST: '127.0.0.1',
      HOMERAIL_MANAGER_PORT: String(this.managerPort),
      HOMERAIL_MANAGER_URL: this.managerUrl,
      HOMERAIL_MANAGER_PUBLIC_URL: this.managerUrl,
      HOMERAIL_UI_HOST: '127.0.0.1',
      HOMERAIL_UI_PORT: String(this.uiHttpsPort),
      HOMERAIL_UI_HTTP_PORT: String(this.uiHttpPort),
      HOMERAIL_UI_SERVE_STATIC: '1',
      HOMERAIL_STATIC_UI_DIR: paths.uiDist,
      // The packaged CLI owns the local Node process so App shutdown can reap it.
      HOMERAIL_LOCAL_NODE_AUTOSTART: '0',
      HOMERAIL_CODEX_BIN: process.env.HOMERAIL_CODEX_BIN || path.join(paths.runtimeRoot, 'codex', 'bin', 'codex'),
    }
  }

  private publish(status: RuntimeStatus): void {
    this.status = status
    this.options.onStatus(this.snapshot)
  }

  private resolvePaths(): { runtimeRoot: string; cliPath: string; uiDist: string } {
    const runtimeRoot = process.env.HOMERAIL_RUNTIME_ROOT
      || (this.options.isPackaged
        ? path.join(process.resourcesPath, 'homerail-runtime')
        : path.resolve(this.options.appPath, '..'))
    return {
      runtimeRoot,
      cliPath: path.join(runtimeRoot, 'homerail_cli', 'dist', 'cli.js'),
      uiDist: path.join(runtimeRoot, 'agent-ui', 'dist'),
    }
  }
}
