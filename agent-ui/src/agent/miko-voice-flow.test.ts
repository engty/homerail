import { describe, expect, it, vi } from 'vitest'
import { MikoVoiceFlow, type MikoVoiceEndReason } from './miko-voice-flow'

describe('MikoVoiceFlow mock end-to-end lifecycle', () => {
  it('guards duplicate wake events and completes wake, connect, and conversation handoff', () => {
    const endings: MikoVoiceEndReason[] = []
    const flow = new MikoVoiceFlow({ onEndRequested: reason => endings.push(reason) })

    expect(flow.beginWake()).toBe(true)
    expect(flow.beginWake()).toBe(false)
    expect(flow.currentState).toBe('wake-detected')

    flow.beginConnecting()
    expect(flow.currentState).toBe('live-connecting')
    flow.connected()
    expect(flow.currentState).toBe('live-listening')
    flow.consumeTranscript('user', '帮我查一下天气')
    flow.consumeTranscript('assistant', '今天晴天', 60_000)
    expect(flow.currentState).toBe('live-listening')
    expect(endings).toEqual([])
    flow.end()
  })

  it('cancels the silence timeout when the user speaks before it expires', () => {
    vi.useFakeTimers()
    const endings: MikoVoiceEndReason[] = []
    const flow = new MikoVoiceFlow({ onEndRequested: reason => endings.push(reason) })
    flow.beginWake()
    flow.connected()
    flow.assistantFinished(15_000)

    vi.advanceTimersByTime(14_999)
    expect(endings).toEqual([])
    flow.userActivity()
    vi.advanceTimersByTime(2_000)
    expect(endings).toEqual([])
    vi.useRealTimers()
  })

  it('does not install a stale timeout when settings resolve after the user speaks', () => {
    vi.useFakeTimers()
    const endings: MikoVoiceEndReason[] = []
    const flow = new MikoVoiceFlow({ onEndRequested: reason => endings.push(reason) })
    flow.beginWake()
    flow.connected()
    const assistantGeneration = flow.beginAssistantTurn()
    expect(assistantGeneration).not.toBeNull()
    flow.userActivity()
    flow.assistantFinished(15_000, assistantGeneration ?? -1)
    vi.advanceTimersByTime(20_000)
    expect(endings).toEqual([])
    vi.useRealTimers()
  })

  it('ends after the configured silence timeout and accepts only the exact end command', () => {
    vi.useFakeTimers()
    const endings: MikoVoiceEndReason[] = []
    const flow = new MikoVoiceFlow({ onEndRequested: reason => endings.push(reason) })
    flow.beginWake()
    flow.connected()
    flow.consumeTranscript('user', '结束对话请')
    expect(endings).toEqual([])
    flow.consumeTranscript('assistant', '好的', 15_000)
    vi.advanceTimersByTime(15_000)
    expect(endings).toEqual(['silence-timeout'])

    flow.end()
    flow.beginWake()
    flow.connected()
    flow.consumeTranscript('user', '结束对话。')
    expect(endings).toEqual(['silence-timeout', 'voice-command'])
    vi.useRealTimers()
  })

  it('keeps reconnecting recoverable and terminates fatal/disconnected sessions safely', () => {
    const endings: MikoVoiceEndReason[] = []
    const flow = new MikoVoiceFlow({ onEndRequested: reason => endings.push(reason) })
    flow.beginWake()
    flow.connected()
    flow.observeClientState('reconnecting')
    expect(flow.currentState).toBe('reconnecting')
    flow.connected()
    expect(flow.currentState).toBe('live-listening')

    flow.fatalError()
    expect(flow.currentState).toBe('error')
    expect(flow.requestEnd('fatal-error')).toBe(false)
    expect(endings).toEqual([])
    flow.end()
    expect(flow.currentState).toBe('idle')
  })
})
