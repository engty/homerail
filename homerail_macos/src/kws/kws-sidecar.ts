import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { AudioDevice, StreamHandle } from 'node-cpal'
import type { KeywordSpotter, KeywordSpotterConfig, KeywordStream, LinearResampler } from 'sherpa-onnx-node'
import { mixToMono, rmsLevel } from './resampler.js'
import {
  encodeKwsMessage,
  KWS_MAX_LINE_BYTES,
  KWS_PROTOCOL_VERSION,
  parseKwsCommand,
  type KwsAudioDevice,
  type KwsCommand,
} from './protocol.js'
import { KWS_KEYWORD_LINE } from './model-manager.js'

const require = createRequire(import.meta.url)
const cpal = require('node-cpal') as CpalApi
const sherpa = require('sherpa-onnx-node') as SherpaApi
const TARGET_SAMPLE_RATE = 16_000
const DEVICE_POLL_INTERVAL_MS = 2_000
const WAKE_COOLDOWN_MS = 2_000

interface CpalApi {
  getDevices(): AudioDevice[]
  getDefaultInputDevice(): AudioDevice
  getDefaultInputConfig(deviceId: string): { sampleRate: number; channels: number; sampleFormat?: 'i16' | 'u16' | 'f32'; format?: 'i16' | 'u16' | 'f32' }
  getSupportedInputConfigs(deviceId: string): Array<{ minSampleRate: number; maxSampleRate: number; channels: number; sampleFormat?: 'i16' | 'u16' | 'f32'; format?: 'i16' | 'u16' | 'f32' }>
  createStream(deviceId: string, input: boolean, config: { sampleRate: number; channels: number; format: 'f32' }, onData: (data: Float32Array) => void): StreamHandle
  closeStream(stream: StreamHandle): void
}

interface SherpaApi {
  KeywordSpotter: new (config: KeywordSpotterConfig) => KeywordSpotter
  LinearResampler: new (inputRate: number, outputRate: number) => LinearResampler
}

interface ConfiguredState {
  generation: number
  modelDir: string
  deviceId: string
  sensitivity: 'low' | 'medium' | 'high'
  spotter: KeywordSpotter
  stream: KeywordStream | null
  inputStream: StreamHandle | null
  nativeSampleRate: number
  channels: number
  resampler: LinearResampler | null
  devicePollTimer: NodeJS.Timeout | null
  desiredListening: boolean
  deviceLost: boolean
  lastWakeAt: number
  lastAudioLevelAt: number
}

const thresholdBySensitivity = { low: 0.35, medium: 0.25, high: 0.15 } as const
let configured: ConfiguredState | null = null
let currentGeneration = 0
let inputBuffer = ''

function send(event: Record<string, unknown>): void {
  process.stdout.write(encodeKwsMessage({
    protocol: KWS_PROTOCOL_VERSION,
    generation: currentGeneration,
    ...event,
  } as never))
}

function sendError(message: string, generation = currentGeneration): void {
  process.stdout.write(encodeKwsMessage({ protocol: KWS_PROTOCOL_VERSION, generation, type: 'error', message: message.slice(0, 500) } as never))
}

function listDevices(): KwsAudioDevice[] {
  return cpal.getDevices().flatMap(device => {
    let configs: ReturnType<CpalApi['getSupportedInputConfigs']>
    try { configs = cpal.getSupportedInputConfigs(device.deviceId) || [] } catch { return [] }
    if (configs.length === 0) return []
    return [{
      name: String(device.name || '').slice(0, 200),
      hostId: String(device.hostId || '').slice(0, 200),
      deviceId: String(device.deviceId || '').slice(0, 512),
      isDefaultInput: Boolean(device.isDefaultInput),
      supportedInputConfigs: configs.map(config => ({
        minSampleRate: config.minSampleRate,
        maxSampleRate: config.maxSampleRate,
        channels: config.channels,
        sampleFormat: config.sampleFormat || config.format || 'f32',
      })),
    }]
  })
}

function chooseInputConfig(deviceId: string): { sampleRate: number; channels: number; sampleFormat: 'f32' } {
  const supported = cpal.getSupportedInputConfigs(deviceId)
  const floatConfig = supported.find(config => (config.sampleFormat || config.format) === 'f32' && config.channels >= 1)
  if (!floatConfig) throw new Error('Selected microphone does not expose a float input stream')
  const sampleRate = floatConfig.minSampleRate <= TARGET_SAMPLE_RATE && floatConfig.maxSampleRate >= TARGET_SAMPLE_RATE
    ? TARGET_SAMPLE_RATE
    : cpal.getDefaultInputConfig(deviceId).sampleRate
  return { sampleRate, channels: Math.max(1, Math.min(2, floatConfig.channels)), sampleFormat: 'f32' }
}

function createSpotter(modelDir: string, sensitivity: ConfiguredState['sensitivity']): KeywordSpotter {
  const paths = {
    encoder: path.join(modelDir, 'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx'),
    decoder: path.join(modelDir, 'decoder-epoch-13-avg-2-chunk-16-left-64.onnx'),
    joiner: path.join(modelDir, 'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx'),
    tokens: path.join(modelDir, 'tokens.txt'),
    keywordsFile: path.join(modelDir, 'keywords.txt'),
  }
  for (const file of Object.values(paths)) {
    if (!fs.statSync(file).isFile()) throw new Error(`Miko wake model file is missing: ${file}`)
  }
  return new sherpa.KeywordSpotter({
    featConfig: { sampleRate: TARGET_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: paths.encoder, decoder: paths.decoder, joiner: paths.joiner },
      tokens: paths.tokens,
      numThreads: 1,
      // CoreML is the supported execution provider on the Apple Silicon
      // targets. The model's int8 encoder/joiner are compatible with it and
      // avoid the CPU provider's incorrect keyword scores on macOS arm64.
      provider: 'coreml',
    },
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: 1,
    keywordsThreshold: thresholdBySensitivity[sensitivity],
    keywordsFile: paths.keywordsFile,
  })
}

function stopStream(state: ConfiguredState): void {
  if (state.inputStream) {
    try { cpal.closeStream(state.inputStream) } catch { /* The device may already be gone. */ }
  }
  state.inputStream = null
  state.stream = null
  state.resampler = null
}

function closeInput(state: ConfiguredState): void {
  if (state.devicePollTimer) clearInterval(state.devicePollTimer)
  state.devicePollTimer = null
  stopStream(state)
}

function monitorDevice(state: ConfiguredState): void {
  if (state.devicePollTimer) return
  state.devicePollTimer = setInterval(() => {
    let found = false
    try {
      found = listDevices().some(device => device.deviceId === state.deviceId)
    } catch (error) {
      sendError(error instanceof Error ? error.message : String(error), state.generation)
      return
    }
    if (!found) {
      if (!state.deviceLost) {
        state.deviceLost = true
        stopStream(state)
        send({ type: 'device-lost', deviceId: state.deviceId })
        if (state.desiredListening) send({ type: 'paused', reason: 'device-lost' })
      }
      return
    }

    if (state.deviceLost) {
      state.deviceLost = false
      send({ type: 'device-restored', deviceId: state.deviceId })
      if (state.desiredListening) {
        try {
          startInput(state)
        } catch (error) {
          state.deviceLost = true
          sendError(error instanceof Error ? error.message : String(error), state.generation)
        }
      }
    }
  }, DEVICE_POLL_INTERVAL_MS)
}

function startInput(state: ConfiguredState): void {
  stopStream(state)
  const config = chooseInputConfig(state.deviceId)
  state.nativeSampleRate = config.sampleRate
  state.channels = config.channels
  state.resampler = config.sampleRate === TARGET_SAMPLE_RATE ? null : new sherpa.LinearResampler(config.sampleRate, TARGET_SAMPLE_RATE)
  state.stream = state.spotter.createStream()
  state.inputStream = cpal.createStream(state.deviceId, true, {
    sampleRate: config.sampleRate,
    channels: config.channels,
    format: 'f32',
  }, data => processAudio(state, data))
  state.deviceLost = false
  monitorDevice(state)
  send({ type: 'listening', deviceId: state.deviceId, sampleRate: TARGET_SAMPLE_RATE })
}

function processAudio(state: ConfiguredState, data: Float32Array): void {
  if (configured !== state || !state.stream) return
  const mono = mixToMono(data, state.channels)
  const now = Date.now()
  if (now - state.lastAudioLevelAt >= 250) {
    state.lastAudioLevelAt = now
    send({ type: 'audio-level', rms: rmsLevel(mono) })
  }
  const samples = state.resampler ? state.resampler.resample(mono) : mono
  if (samples.length === 0) return
  state.stream.acceptWaveform({ sampleRate: TARGET_SAMPLE_RATE, samples })
  while (state.stream && state.spotter.isReady(state.stream)) {
    state.spotter.decode(state.stream)
    const result = state.spotter.getResult(state.stream)
    if (result.keyword && result.keyword.toUpperCase().includes('MIKO') && now - state.lastWakeAt >= WAKE_COOLDOWN_MS) {
      state.lastWakeAt = now
      state.desiredListening = false
      closeInput(state)
      send({ type: 'wake', keyword: 'MIKO', detectedAt: now })
      send({ type: 'paused', reason: 'wake' })
      return
    }
  }
}

function configure(command: Extract<KwsCommand, { type: 'configure' }>): void {
  if (!path.isAbsolute(command.modelDir) || command.modelDir.split(path.sep).includes('..')) throw new Error('Miko model path must be an absolute safe path')
  if (configured) closeInput(configured)
  const device = listDevices().find(item => item.deviceId === command.deviceId)
  if (!device) throw new Error('Selected microphone is not available')
  const spotter = createSpotter(command.modelDir, command.sensitivity)
  configured = {
    generation: command.generation,
    modelDir: command.modelDir,
    deviceId: command.deviceId,
    sensitivity: command.sensitivity,
    spotter,
    stream: null,
    inputStream: null,
    nativeSampleRate: TARGET_SAMPLE_RATE,
    channels: 1,
    resampler: null,
    devicePollTimer: null,
    desiredListening: false,
    deviceLost: false,
    lastWakeAt: 0,
    lastAudioLevelAt: 0,
  }
  currentGeneration = command.generation
  send({ type: 'ready', deviceId: command.deviceId, sampleRate: TARGET_SAMPLE_RATE })
}

function handle(command: KwsCommand): void {
  if (command.type === 'list-devices') {
    currentGeneration = Math.max(currentGeneration, command.generation)
    send({ type: 'devices', devices: listDevices() })
    return
  }
  if (command.generation < currentGeneration) return
  try {
    switch (command.type) {
      case 'configure': configure(command); break
      case 'start':
        if (!configured) throw new Error('Miko wake service is not configured')
        currentGeneration = command.generation
        configured.desiredListening = true
        startInput(configured)
        break
      case 'pause':
        if (configured) {
          configured.desiredListening = false
          closeInput(configured)
        }
        currentGeneration = command.generation
        send({ type: 'paused', reason: 'requested' })
        break
      case 'ping': send({ type: 'pong' }); break
      case 'shutdown':
        if (configured) closeInput(configured)
        process.exit(0)
    }
  } catch (error) {
    sendError(error instanceof Error ? error.message : String(error), command.generation)
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  inputBuffer += String(chunk)
  if (Buffer.byteLength(inputBuffer, 'utf8') > KWS_MAX_LINE_BYTES * 2) {
    inputBuffer = ''
    sendError('KWS command buffer exceeded its limit')
    return
  }
  let newlineIndex = inputBuffer.indexOf('\n')
  while (newlineIndex >= 0) {
    const line = inputBuffer.slice(0, newlineIndex).trim()
    inputBuffer = inputBuffer.slice(newlineIndex + 1)
    if (line) {
      const command = parseKwsCommand(line)
      if (command) handle(command)
      else sendError('Malformed KWS command')
    }
    newlineIndex = inputBuffer.indexOf('\n')
  }
})
process.on('SIGTERM', () => {
  if (configured) closeInput(configured)
  process.exit(0)
})
process.on('SIGINT', () => {
  if (configured) closeInput(configured)
  process.exit(0)
})

send({ type: 'pong' })
