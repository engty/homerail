import { createInterface } from 'node:readline'
import { spawn, type ChildProcess } from 'node:child_process'

export interface ChildProcessSpec {
  label: string
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface ChildProcessCallbacks {
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  onError?: (error: Error) => void
}

export class ChildProcessSupervisor {
  private child: ChildProcess | null = null
  private stopping = false

  constructor(
    private readonly spec: ChildProcessSpec,
    private readonly callbacks: ChildProcessCallbacks = {},
  ) {}

  get pid(): number | undefined {
    return this.child?.pid ?? undefined
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed
  }

  start(): void {
    if (this.running) return
    this.stopping = false
    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: this.spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    const stdout = child.stdout
    const stderr = child.stderr
    if (stdout) {
      createInterface({ input: stdout }).on('line', line => this.callbacks.onLine?.('stdout', line))
    }
    if (stderr) {
      createInterface({ input: stderr }).on('line', line => this.callbacks.onLine?.('stderr', line))
    }
    child.once('error', error => {
      this.callbacks.onError?.(error)
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null
      if (!this.stopping) this.callbacks.onExit?.(code, signal)
    })
  }

  send(line: string): boolean {
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed) return false
    return stdin.write(line)
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    const child = this.child
    if (!child) return
    this.stopping = true
    await new Promise<void>(resolve => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
        finish()
      }, timeoutMs)
      child.once('exit', finish)
      child.kill('SIGTERM')
    })
    if (this.child === child) this.child = null
  }
}
