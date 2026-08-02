export function mixToMono(input: Float32Array, channels: number): Float32Array {
  if (!Number.isInteger(channels) || channels < 1) throw new Error('Audio channel count must be a positive integer')
  if (channels === 1) return input
  const frameCount = Math.floor(input.length / channels)
  const mono = new Float32Array(frameCount)
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) sum += input[frame * channels + channel] || 0
    mono[frame] = sum / channels
  }
  return mono
}

export function rmsLevel(input: Float32Array): number {
  if (input.length === 0) return 0
  let sum = 0
  for (const value of input) sum += value * value
  return Math.min(1, Math.sqrt(sum / input.length))
}
