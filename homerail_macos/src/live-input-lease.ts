export const LIVE_INPUT_LEASE_TIMEOUT_MS = 8_000

export type LiveInputLeaseExpiryHandler = () => void

/**
 * Keeps the main process fail-closed while the renderer owns the microphone.
 * A renderer heartbeat must renew the lease before the deadline; a missing
 * heartbeat never re-arms KWS automatically.
 */
export class LiveInputLease {
  private timer: NodeJS.Timeout | null = null
  private expiresAt = 0
  private active = false

  constructor(
    private readonly onExpired: LiveInputLeaseExpiryHandler,
    private readonly timeoutMs = LIVE_INPUT_LEASE_TIMEOUT_MS,
  ) {}

  get isActive(): boolean {
    return this.active
  }

  acquire(): void {
    this.active = true
    this.expiresAt = Date.now() + this.timeoutMs
    this.armTimer()
  }

  renew(): boolean {
    if (!this.active) return false
    if (Date.now() >= this.expiresAt) {
      this.expire()
      return false
    }
    this.expiresAt = Date.now() + this.timeoutMs
    this.armTimer()
    return true
  }

  release(): void {
    this.active = false
    this.expiresAt = 0
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.active) return
      if (Date.now() < this.expiresAt) {
        this.armTimer()
        return
      }
      this.expire()
    }, this.timeoutMs)
    this.timer.unref?.()
  }

  private expire(): void {
    if (!this.active) return
    this.release()
    this.onExpired()
  }
}
