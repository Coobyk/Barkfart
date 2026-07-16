import { Mp3Encoder } from '@breezystack/lamejs'

/** Export sample rate — lower = much faster mix + encode; fine for meme audio */
export const EXPORT_SAMPLE_RATE = 22050

/**
 * Mix notes into a mono Float32Array by resampling sample buffers.
 * Much faster / more reliable than OfflineAudioContext with thousands of nodes.
 *
 * @param {object} opts
 * @param {{ time: number, midi: number, velocity: number, track: number }[]} opts.notes
 * @param {{ barks: AudioBuffer[], farts: AudioBuffer[] }} opts.banks
 * @param {(note: object, index: number) => 'bark' | 'fart'} opts.pickKind
 * @param {(midi: number, kind: string) => number} opts.rateForNote
 * @param {number} opts.durationSec
 * @param {number} opts.volume
 * @param {number} [opts.tempoScale]
 * @param {number} [opts.sampleRate]
 * @param {(pct: number) => void} [opts.onProgress]
 * @returns {Promise<Float32Array>}
 */
export async function renderMix({
  notes,
  banks,
  pickKind,
  rateForNote,
  durationSec,
  volume,
  tempoScale = 1,
  sampleRate = EXPORT_SAMPLE_RATE,
  onProgress,
}) {
  const tail = 1.2
  const length = Math.max(1, Math.ceil((durationSec / tempoScale + tail) * sampleRate))
  const out = new Float32Array(length)

  // Cache mono views of each sample buffer
  /** @type {WeakMap<AudioBuffer, Float32Array>} */
  const monoCache = new WeakMap()
  function monoOf(buf) {
    let m = monoCache.get(buf)
    if (m) return m
    const n = buf.length
    m = new Float32Array(n)
    if (buf.numberOfChannels === 1) {
      m.set(buf.getChannelData(0))
    } else {
      const L = buf.getChannelData(0)
      const R = buf.getChannelData(1)
      for (let i = 0; i < n; i++) m[i] = (L[i] + R[i]) * 0.5
    }
    monoCache.set(buf, m)
    return m
  }

  const total = notes.length || 1
  let lastYield = performance.now()

  for (let index = 0; index < notes.length; index++) {
    const note = notes[index]
    const kind = pickKind(note, index)
    // Same sample every time for a given kind (consistent bark vs fart)
    const sample = kind === 'bark' ? banks.barks[0] : banks.farts[0]
    const rate = Math.max(0.001, rateForNote(note.midi, kind))
    const gain = volume * (0.35 + note.velocity * 0.65)
    const when = note.time / tempoScale
    const src = monoOf(sample)
    // Adjust for sample's native rate vs export rate
    const rateScale = (sample.sampleRate / sampleRate) * rate
    mixResampled(out, src, when * sampleRate, rateScale, gain)

    if (index % 32 === 0) {
      const now = performance.now()
      if (now - lastYield > 40) {
        onProgress?.(Math.min(90, (index / total) * 90))
        await new Promise((r) => setTimeout(r, 0))
        lastYield = performance.now()
      }
    }
  }

  // Peak normalize to ~0.95 so quiet mixes aren't silent and loud ones don't clip badly
  let peak = 0
  for (let i = 0; i < length; i++) {
    const a = Math.abs(out[i])
    if (a > peak) peak = a
  }
  if (peak > 0.001) {
    const g = 0.95 / peak
    for (let i = 0; i < length; i++) out[i] *= g
  }

  onProgress?.(92)
  return out
}

/**
 * Add a pitch-rate-resampled mono sample into `out` starting at `startSample`.
 */
function mixResampled(out, src, startSample, rateScale, gain) {
  const outLen = out.length
  const srcLen = src.length
  if (srcLen < 2 || rateScale <= 0) return

  const start = Math.floor(startSample)
  // how many output samples this note covers
  const nOut = Math.floor(srcLen / rateScale)
  for (let i = 0; i < nOut; i++) {
    const oi = start + i
    if (oi < 0) continue
    if (oi >= outLen) break

    const srcPos = i * rateScale
    const i0 = srcPos | 0
    if (i0 >= srcLen - 1) {
      out[oi] += src[srcLen - 1] * gain
      continue
    }
    const frac = srcPos - i0
    const s = src[i0] * (1 - frac) + src[i0 + 1] * frac
    out[oi] += s * gain
  }
}

/**
 * Fast WAV encode (PCM 16-bit mono). Nearly instant.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {Blob}
 */
export function encodeWav(samples, sampleRate = EXPORT_SAMPLE_RATE) {
  const numSamples = samples.length
  const buffer = new ArrayBuffer(44 + numSamples * 2)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + numSamples * 2, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits
  writeString(view, 36, 'data')
  view.setUint32(40, numSamples * 2, true)

  let offset = 44
  for (let i = 0; i < numSamples; i++) {
    let s = samples[i]
    if (s > 1) s = 1
    else if (s < -1) s = -1
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

/**
 * Encode mono float samples to MP3 (fast path: mono, 128kbps, bulk convert).
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {(pct: number) => void} [onProgress]
 * @returns {Promise<Blob>}
 */
export async function encodeMp3(samples, sampleRate = EXPORT_SAMPLE_RATE, onProgress) {
  // lamejs is happiest at common rates
  const rate = pickLameRate(sampleRate)
  let pcm = samples
  if (rate !== sampleRate) {
    pcm = resampleLinear(samples, sampleRate, rate)
  }

  const n = pcm.length
  const int16 = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    let s = pcm[i]
    if (s > 1) s = 1
    else if (s < -1) s = -1
    int16[i] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0
  }

  const kbps = 128
  const encoder = new Mp3Encoder(1, rate, kbps)
  const block = 1152
  const mp3Chunks = []
  let lastYield = performance.now()

  for (let i = 0; i < n; i += block) {
    const end = Math.min(i + block, n)
    // lamejs needs a plain Int16Array of the block length
    const chunk =
      end - i === block
        ? int16.subarray(i, end)
        : int16.slice(i, end)
    const buf = encoder.encodeBuffer(chunk)
    if (buf.length > 0) mp3Chunks.push(buf)

    if (i % (block * 32) === 0) {
      const now = performance.now()
      if (now - lastYield > 45) {
        onProgress?.(Math.min(99, 92 + (i / n) * 7))
        await new Promise((r) => setTimeout(r, 0))
        lastYield = performance.now()
      }
    }
  }

  const end = encoder.flush()
  if (end.length > 0) mp3Chunks.push(end)
  onProgress?.(100)

  return new Blob(mp3Chunks, { type: 'audio/mpeg' })
}

function pickLameRate(sr) {
  // Prefer rates lame is known to handle well
  if (sr === 44100 || sr === 48000 || sr === 22050 || sr === 24000 || sr === 16000) return sr
  return 22050
}

function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const outLen = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio
    const i0 = srcPos | 0
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = srcPos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 8000)
}
