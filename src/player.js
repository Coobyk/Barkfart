import { Midi } from '@tonejs/midi'
import { createSampleBanks, playBuffer } from './sounds.js'
import { renderMix, EXPORT_SAMPLE_RATE } from './exportAudio.js'

/** @typedef {'auto' | 'bark' | 'fart' | 'alternate'} SoundMode */

export class BarkfartPlayer {
  constructor() {
    /** @type {AudioContext | null} */
    this.ctx = null
    /** @type {{ barks: AudioBuffer[], farts: AudioBuffer[] } | null} */
    this.banks = null
    /** @type {Midi | null} */
    this.midi = null
    /** @type {{ time: number, duration: number, midi: number, velocity: number, track: number }[]} */
    this.notes = []
    this.duration = 0
    this.playing = false
    this.startTime = 0
    this.pauseOffset = 0
    /** @type {AudioBufferSourceNode[]} */
    this.activeSources = []
    /** @type {number | null} */
    this.raf = null
    /** @type {((t: number, dur: number) => void) | null} */
    this.onProgress = null
    /** @type {(() => void) | null} */
    this.onEnded = null
    /** @type {SoundMode} */
    this.mode = 'auto'
    this.volume = 0.85
    this.tempoScale = 1
    /** MIDI note where LH (fart) ends and RH (bark) begins. Default: middle C. */
    this.splitMidi = 60
  }

  async ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext()
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume()
    }
    if (!this.banks) {
      this.banks = await createSampleBanks(this.ctx, 8)
    }
    return this.ctx
  }

  /**
   * @param {ArrayBuffer} arrayBuffer
   */
  async loadMidi(arrayBuffer) {
    this.stop()
    this.midi = new Midi(arrayBuffer)
    this.notes = []
    let maxEnd = 0

    this.midi.tracks.forEach((track, trackIndex) => {
      for (const note of track.notes) {
        this.notes.push({
          time: note.time,
          duration: note.duration,
          midi: note.midi,
          velocity: note.velocity,
          track: trackIndex,
        })
        maxEnd = Math.max(maxEnd, note.time + Math.max(note.duration, 0.05))
      }
    })

    // Stable chronological order
    this.notes.sort((a, b) => a.time - b.time || a.midi - b.midi)
    // MIDI files can contain a silent lead-in before their first note. The
    // transport should begin when the music does, while keeping every note's
    // spacing intact.
    const firstNoteTime = this.notes[0]?.time ?? 0
    if (firstNoteTime > 0) {
      for (const note of this.notes) note.time -= firstNoteTime
      maxEnd -= firstNoteTime
    }
    this.duration = maxEnd + 0.4
    this.pauseOffset = 0
    return {
      name: this.midi.name || 'Untitled',
      duration: this.duration,
      noteCount: this.notes.length,
      tracks: this.midi.tracks.length,
      bpm: this.midi.header.tempos[0]?.bpm ?? 120,
    }
  }

  /**
   * Decide bark vs fart for a note.
   * Auto = piano hands: below split → fart (left), at/above split → bark (right).
   * No mixing in the middle — same pitch always gets the same kind.
   * @param {{ midi: number, track: number, time: number }} note
   * @param {number} index
   * @returns {'bark' | 'fart'}
   */
  pickKind(note, index) {
    if (this.mode === 'bark') return 'bark'
    if (this.mode === 'fart') return 'fart'
    if (this.mode === 'alternate') return index % 2 === 0 ? 'bark' : 'fart'

    // Strict split: lower notes fart, higher notes bark (like LH / RH on piano)
    return note.midi < this.splitMidi ? 'fart' : 'bark'
  }

  /**
   * Pitch rate from MIDI note number (C4 = 60 → rate 1).
   */
  rateForNote(midi, kind) {
    const center = kind === 'fart' ? 48 : 64
    // Full MIDI range — no pitch cap (high notes used to clip at ±18 semitones)
    return Math.pow(2, (midi - center) / 12)
  }

  /**
   * Schedule notes from `fromTime` (song seconds) onward.
   */
  scheduleFrom(fromTime) {
    if (!this.ctx || !this.banks) return
    const ctxNow = this.ctx.currentTime
    const lookAheadEnd = this.duration + 1

    this.notes.forEach((note, index) => {
      if (note.time < fromTime - 0.001) return
      if (note.time > lookAheadEnd) return

      const when = ctxNow + (note.time - fromTime) / this.tempoScale
      const kind = this.pickKind(note, index)
      // Always the same sample per kind — pitch comes only from playback rate
      const sample = kind === 'bark' ? this.banks.barks[0] : this.banks.farts[0]
      const rate = this.rateForNote(note.midi, kind)
      // Slight pan by pitch for stereo interest
      const pan = ((note.midi - 60) / 40) * 0.55
      const gain = this.volume * (0.35 + note.velocity * 0.65)

      const src = playBuffer(this.ctx, sample, when, { rate, gain, pan })
      this.activeSources.push(src)
      src.onended = () => {
        const i = this.activeSources.indexOf(src)
        if (i >= 0) this.activeSources.splice(i, 1)
      }
    })
  }

  clearSources() {
    for (const src of this.activeSources) {
      try {
        src.stop()
      } catch {
        /* already stopped */
      }
    }
    this.activeSources = []
  }

  async play() {
    await this.ensureContext()
    if (!this.notes.length) return

    this.clearSources()
    this.playing = true
    this.startTime = this.ctx.currentTime
    this.scheduleFrom(this.pauseOffset)
    this.tick()
  }

  pause() {
    if (!this.playing || !this.ctx) return
    const elapsed = (this.ctx.currentTime - this.startTime) * this.tempoScale
    this.pauseOffset = Math.min(this.duration, this.pauseOffset + elapsed)
    this.playing = false
    this.clearSources()
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = null
    this.onProgress?.(this.pauseOffset, this.duration)
  }

  stop() {
    this.playing = false
    this.pauseOffset = 0
    this.clearSources()
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = null
    this.onProgress?.(0, this.duration)
  }

  seek(time) {
    const t = Math.max(0, Math.min(this.duration, time))
    const wasPlaying = this.playing
    this.pause()
    this.pauseOffset = t
    this.onProgress?.(t, this.duration)
    if (wasPlaying) this.play()
  }

  getCurrentTime() {
    if (!this.ctx) return this.pauseOffset
    if (!this.playing) return this.pauseOffset
    const elapsed = (this.ctx.currentTime - this.startTime) * this.tempoScale
    return Math.min(this.duration, this.pauseOffset + elapsed)
  }

  tick() {
    if (!this.playing) return
    const t = this.getCurrentTime()
    this.onProgress?.(t, this.duration)
    if (t >= this.duration - 0.02) {
      this.playing = false
      this.pauseOffset = 0
      this.clearSources()
      this.onProgress?.(0, this.duration)
      this.onEnded?.()
      return
    }
    this.raf = requestAnimationFrame(() => this.tick())
  }

  /**
   * Fast offline mix for export (manual buffer mix, not OfflineAudioContext).
   * @param {(pct: number) => void} [onProgress]
   * @returns {Promise<Float32Array>}
   */
  async renderForExport(onProgress) {
    if (!this.notes.length) throw new Error('No MIDI loaded')
    await this.ensureContext()
    if (!this.banks) throw new Error('Samples not loaded')

    return renderMix({
      notes: this.notes,
      banks: this.banks,
      pickKind: (note, index) => this.pickKind(note, index),
      rateForNote: (midi, kind) => this.rateForNote(midi, kind),
      durationSec: this.duration,
      volume: this.volume,
      tempoScale: this.tempoScale,
      sampleRate: EXPORT_SAMPLE_RATE,
      onProgress,
    })
  }
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
