declare module 'sherpa-onnx-node' {
  export interface KeywordSpotterConfig {
    featConfig: { sampleRate: number; featureDim: number }
    modelConfig: {
      transducer: { encoder: string; decoder: string; joiner: string }
      tokens: string
      numThreads?: number
      provider?: string
      debug?: boolean | number
    }
    maxActivePaths?: number
    numTrailingBlanks?: number
    keywordsScore?: number
    keywordsThreshold?: number
    keywordsFile: string
  }

  export interface KeywordResult {
    start_time: number
    keyword: string
    timestamps: number[]
    tokens: string[]
  }

  export interface KeywordStream {
    acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void
  }

  export class KeywordSpotter {
    constructor(config: KeywordSpotterConfig)
    createStream(): KeywordStream
    isReady(stream: KeywordStream): boolean
    decode(stream: KeywordStream): void
    getResult(stream: KeywordStream): KeywordResult
  }

  export class LinearResampler {
    constructor(inputSampleRate: number, outputSampleRate: number)
    resample(samples: Float32Array): Float32Array
    reset(): void
  }
}
