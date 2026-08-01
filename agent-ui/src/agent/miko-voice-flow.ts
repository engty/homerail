import { normalizeVoiceTranscriptForDuplicate } from '@/utils/voice-transcript'
import type { CodexLiveVoiceState } from './codex-live-voice-client'

export type MikoVoiceFlowState =
  | 'idle'
  | 'wake-detected'
  | 'live-connecting'
  | 'live-listening'
  | 'reconnecting'
  | 'ending'
  | 'error'

export type MikoVoiceEndReason = 'voice-command' | 'silence-timeout' | 'menu' | 'fatal-error'

export interface MikoVoiceFlowOptions {
  onEndRequested: (reason: MikoVoiceEndReason) => void
  setTimeout?: (handler: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
}

/**
 * Keeps wake/live handoff and the local conversation ending rules deterministic.
 * The Electron and WebRTC objects stay outside this policy so the same rules can
 * be exercised with a mock transport and without requesting a real microphone.
 */
export class MikoVoiceFlow {
  private state: MikoVoiceFlowState = 'idle'
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private readonly setTimer: NonNullable<MikoVoiceFlowOptions['setTimeout']>
  private readonly clearTimer: NonNullable<MikoVoiceFlowOptions['clearTimeout']>

  constructor(private readonly options: MikoVoiceFlowOptions) {
    this.setTimer = options.setTimeout ?? ((handler, timeoutMs) => setTimeout(handler, timeoutMs))
    this.clearTimer = options.clearTimeout ?? (timer => clearTimeout(timer))
  }

  get currentState(): MikoVoiceFlowState {
    return this.state
  }

  beginWake(): boolean {
    if (this.state !== 'idle') return false
    this.state = 'wake-detected'
    return true
  }

  beginConnecting(): void {
    if (this.state === 'idle' || this.state === 'wake-detected') this.state = 'live-connecting'
  }

  connected(): void {
    if (
      this.state === 'idle' ||
      this.state === 'wake-detected' ||
      this.state === 'live-connecting' ||
      this.state === 'reconnecting'
    ) {
      this.state = 'live-listening'
    }
  }

  observeClientState(state: CodexLiveVoiceState): void {
    if (state === 'reconnecting') {
      this.clearSilenceTimer()
      if (this.state !== 'idle' && this.state !== 'ending') this.state = 'reconnecting'
      return
    }
    if (state === 'connecting') {
      this.beginConnecting()
      return
    }
    if (
      state === 'listening' ||
      state === 'user-speaking' ||
      state === 'manager-working' ||
      state === 'assistant-speaking' ||
      state === 'muted'
    ) {
      this.connected()
      return
    }
    if (state === 'error') this.fatalError()
  }

  userActivity(): void {
    if (!this.isConversationActive()) return
    this.clearSilenceTimer()
    if (this.state === 'reconnecting') return
    this.state = 'live-listening'
  }

  beginAssistantTurn(): number | null {
    if (!this.isConversationActive()) return null
    this.clearSilenceTimer()
    this.state = 'live-listening'
    return this.generation
  }

  assistantFinished(timeoutMs: number, expectedGeneration?: number): void {
    if (!this.isConversationActive()) return
    if (expectedGeneration !== undefined && expectedGeneration !== this.generation) return
    const boundedTimeout = Math.max(15_000, Math.min(300_000, Math.round(timeoutMs)))
    this.clearSilenceTimer()
    const generation = ++this.generation
    this.silenceTimer = this.setTimer(() => {
      if (generation !== this.generation || !this.isConversationActive()) return
      this.silenceTimer = null
      this.requestEnd('silence-timeout')
    }, boundedTimeout)
    this.state = 'live-listening'
  }

  consumeTranscript(role: 'user' | 'assistant', text: string, assistantTimeoutMs?: number): void {
    if (role === 'user') {
      this.userActivity()
      if (normalizeVoiceTranscriptForDuplicate(text) === '结束对话')
        this.requestEnd('voice-command')
      return
    }
    if (assistantTimeoutMs !== undefined) this.assistantFinished(assistantTimeoutMs)
  }

  fatalError(): void {
    if (this.state === 'idle') return
    this.clearSilenceTimer()
    this.state = 'error'
  }

  requestEnd(reason: MikoVoiceEndReason): boolean {
    if (!this.isConversationActive()) return false
    this.clearSilenceTimer()
    this.state = 'ending'
    this.options.onEndRequested(reason)
    return true
  }

  clearSilenceTimer(): void {
    if (this.silenceTimer !== null) this.clearTimer(this.silenceTimer)
    this.silenceTimer = null
    this.generation += 1
  }

  end(): void {
    this.clearSilenceTimer()
    this.state = 'idle'
  }

  private isConversationActive(): boolean {
    return this.state !== 'idle' && this.state !== 'ending' && this.state !== 'error'
  }
}
