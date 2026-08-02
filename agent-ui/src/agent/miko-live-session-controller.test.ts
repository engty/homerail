import { describe, expect, it, vi } from 'vitest'
import { MikoLiveSessionController, type MikoDesktopVoiceApi } from './miko-live-session-controller'

describe('MikoLiveSessionController', () => {
  it('pauses KWS before activation and renews the desktop lease', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const api: MikoDesktopVoiceApi = {
      pauseWakeListening: async () => { calls.push('pause') },
      setLiveSessionActive: async active => { calls.push(`active:${active}`); return { liveSessionActive: active } },
      renewLiveSessionLease: async () => { calls.push('renew'); return { liveSessionActive: true } },
    }
    const controller = new MikoLiveSessionController(() => api, vi.fn(), 20)
    await controller.prepareInput()
    await controller.activate()
    expect(calls).toEqual(['pause', 'active:true'])
    await vi.advanceTimersByTimeAsync(20)
    expect(calls).toEqual(['pause', 'active:true', 'renew'])
    controller.dispose()
    vi.useRealTimers()
  })

  it('reports a lost lease and stops heartbeats', async () => {
    vi.useFakeTimers()
    const onLeaseLost = vi.fn()
    const api: MikoDesktopVoiceApi = {
      setLiveSessionActive: async () => ({ liveSessionActive: true }),
      renewLiveSessionLease: async () => ({ liveSessionActive: false }),
    }
    const controller = new MikoLiveSessionController(() => api, onLeaseLost, 10)
    await controller.activate()
    await vi.advanceTimersByTimeAsync(10)
    expect(onLeaseLost).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(30)
    expect(onLeaseLost).toHaveBeenCalledOnce()
    controller.dispose()
    vi.useRealTimers()
  })

  it('releases the lease without rearming KWS for an ownership handoff', async () => {
    const calls: string[] = []
    const api: MikoDesktopVoiceApi = {
      setLiveSessionActive: async active => { calls.push(`active:${active}`); return { liveSessionActive: active } },
      endConversation: async () => { calls.push('end') },
    }
    const controller = new MikoLiveSessionController(() => api, vi.fn())
    await controller.activate()
    await controller.deactivate(false)
    expect(calls).toEqual(['active:true', 'active:false'])
  })
})
