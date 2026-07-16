/**
 * Load bark/fart samples and play them with pitch/gain via Web Audio.
 */

import { publicUrl } from './base.js'

const BARK_URL = publicUrl('bark.mp3')
const FART_URL = publicUrl('fart.mp3')

/** @type {{ bark: AudioBuffer, fart: AudioBuffer } | null} */
let cachedSamples = null

/**
 * Decode an audio file URL into an AudioBuffer.
 * @param {BaseAudioContext} ctx
 * @param {string} url
 */
async function decodeUrl(ctx, url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`)
  const arrayBuffer = await res.arrayBuffer()
  // copy for decodeAudioData (some browsers detach the buffer)
  return ctx.decodeAudioData(arrayBuffer.slice(0))
}

/**
 * Slice a short one-shot from a buffer (trims silence-ish edges lightly).
 * Also allows small start-offset variants for variety.
 * @param {BaseAudioContext} ctx
 * @param {AudioBuffer} source
 * @param {number} startOffsetSec
 * @param {number} maxDurationSec
 */
function makeVariant(ctx, source, startOffsetSec = 0, maxDurationSec = 1.2) {
  const sr = source.sampleRate
  const channels = source.numberOfChannels
  const start = Math.min(
    Math.floor(startOffsetSec * sr),
    Math.max(0, source.length - 1),
  )
  const maxLen = Math.floor(maxDurationSec * sr)
  const length = Math.min(maxLen, source.length - start)
  if (length <= 0) return source

  const out = ctx.createBuffer(channels, length, sr)
  for (let c = 0; c < channels; c++) {
    const src = source.getChannelData(c)
    const dst = out.getChannelData(c)
    for (let i = 0; i < length; i++) {
      // short fade-in / fade-out to avoid clicks
      let g = 1
      const fade = Math.min(64, Math.floor(length / 8))
      if (i < fade) g = i / fade
      else if (i > length - fade) g = (length - i) / fade
      dst[i] = src[start + i] * g
    }
  }
  return out
}

/**
 * Load bark.mp3 + fart.mp3 and build sample banks (with light variants).
 * @param {BaseAudioContext} ctx
 * @param {number} count
 * @returns {Promise<{ barks: AudioBuffer[], farts: AudioBuffer[] }>}
 */
export async function createSampleBanks(ctx, count = 6) {
  if (!cachedSamples) {
    const [bark, fart] = await Promise.all([
      decodeUrl(ctx, BARK_URL),
      decodeUrl(ctx, FART_URL),
    ])
    cachedSamples = { bark, fart }
  }

  const { bark, fart } = cachedSamples
  const barkDur = bark.duration
  const fartDur = fart.duration

  const barks = []
  const farts = []
  for (let i = 0; i < count; i++) {
    // Slight start offsets so repeated notes don't phase-lock identically
    const barkStart = barkDur > 0.15 ? (i * 0.02) % Math.max(0.01, barkDur * 0.15) : 0
    const fartStart = fartDur > 0.15 ? (i * 0.025) % Math.max(0.01, fartDur * 0.2) : 0
    barks.push(makeVariant(ctx, bark, barkStart, Math.min(1.0, barkDur)))
    farts.push(makeVariant(ctx, fart, fartStart, Math.min(1.4, fartDur)))
  }

  return { barks, farts }
}

/**
 * Clear cached samples (e.g. if files change during dev).
 */
export function clearSampleCache() {
  cachedSamples = null
}

/**
 * Play a one-shot buffer at a given time with pitch rate & gain.
 */
export function playBuffer(ctx, buffer, when, { rate = 1, gain = 1, pan = 0, dest = null } = {}) {
  const src = ctx.createBufferSource()
  src.buffer = buffer
  // Only guard non-positive rates (Web Audio requires playbackRate > 0)
  src.playbackRate.value = Math.max(0.001, rate)

  const g = ctx.createGain()
  g.gain.value = Math.max(0, Math.min(1.5, gain))

  if (ctx.createStereoPanner) {
    const panner = ctx.createStereoPanner()
    panner.pan.value = Math.max(-1, Math.min(1, pan))
    src.connect(panner)
    panner.connect(g)
  } else {
    src.connect(g)
  }

  g.connect(dest || ctx.destination)
  src.start(when)
  return src
}
