export interface MikoDesktopVoiceApi {
  pauseWakeListening?: () => Promise<unknown>
  setLiveSessionActive?: (active: boolean) => Promise<{ liveSessionActive?: boolean } | unknown>
  renewLiveSessionLease?: () => Promise<{ liveSessionActive?: boolean } | unknown>
  endConversation?: () => Promise<unknown>
}

export type MikoDesktopVoiceApiProvider = () => MikoDesktopVoiceApi | null

export class MikoLiveSessionController {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatInFlight = false

  constructor(
    private readonly getApi: MikoDesktopVoiceApiProvider,
    private readonly onLeaseLost: (reason: Error) => void,
    private readonly heartbeatIntervalMs = 2_000,
  ) {}

  async prepareInput(): Promise<void> {
    await this.getApi()?.pauseWakeListening?.()
  }

  async activate(): Promise<void> {
    this.stopHeartbeat()
    const api = this.getApi()
    const status = await api?.setLiveSessionActive?.(true)
    if (api?.renewLiveSessionLease && (status as { liveSessionActive?: boolean } | undefined)?.liveSessionActive !== true) {
      throw new Error('GPT Live 麦克风租约未建立')
    }
    if (api?.renewLiveSessionLease) this.startHeartbeat()
  }

  async deactivate(notifyServer: boolean): Promise<void> {
    this.stopHeartbeat()
    const api = this.getApi()
    if (notifyServer) await api?.endConversation?.()
    else await api?.setLiveSessionActive?.(false)
  }

  dispose(): void {
    this.stopHeartbeat()
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.heartbeatInFlight = false
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      const api = this.getApi()
      if (!api?.renewLiveSessionLease || this.heartbeatInFlight) return
      this.heartbeatInFlight = true
      void Promise.resolve(api.renewLiveSessionLease())
        .then(status => {
          if ((status as { liveSessionActive?: boolean } | undefined)?.liveSessionActive === true) return
          this.notifyLeaseLost(new Error('GPT Live 麦克风租约已失效'))
        })
        .catch(error => {
          this.notifyLeaseLost(error instanceof Error ? error : new Error(String(error)))
        })
        .finally(() => {
          this.heartbeatInFlight = false
        })
    }, this.heartbeatIntervalMs)
  }

  private notifyLeaseLost(reason: Error): void {
    this.stopHeartbeat()
    this.onLeaseLost(reason)
  }
}
