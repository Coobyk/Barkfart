import { Midi } from '@tonejs/midi'
import { createSampleBanks } from './sounds.js'
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
    /** @type {{ time: number, duration: number, midi: number, velocity: number, midiGain: number, track: number }[]} */
    this.notes = []
    this.duration = 0
    this.playing = false
    this.startTime = 0
    this.pauseOffset = 0
    /** @type {AudioBufferSourceNode[]} */
    this.activeSources = []
    /** @type {GainNode | null} */
    this.outputGain = null
    /** @type {number | null} */
    this.raf = null
    /** @type {((t: number, dur: number) => void) | null} */
    this.onProgress = null
    /** @type {(() => void) | null} */
    this.onEnded = null
    /** @type {SoundMode} */
    this.mode = 'auto'
    this.volume = 1
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
    if (!this.outputGain) {
      this.outputGain = this.ctx.createGain()
      this.outputGain.gain.value = this.volume
      this.outputGain.connect(this.ctx.destination)
    }
    if (!this.banks) {
      this.banks = await createSampleBanks(this.ctx, 8)
    }
    return this.ctx
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume))
    if (this.outputGain) this.outputGain.gain.value = this.volume
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
      // CC7 is channel volume and CC11 is expression. Use the most recent
      // controller values at each note-on time, just as a MIDI instrument does.
      const channelVolumes = track.controlChanges[7] || []
      const expressions = track.controlChanges[11] || []
      let volumeIndex = 0
      let expressionIndex = 0
      let channelVolume = 1
      let expression = 1

      for (const note of track.notes) {
        while (channelVolumes[volumeIndex]?.time <= note.time) {
          channelVolume = channelVolumes[volumeIndex++].value
        }
        while (expressions[expressionIndex]?.time <= note.time) {
          expression = expressions[expressionIndex++].value
        }
        this.notes.push({
          time: note.time,
          duration: note.duration,
          midi: note.midi,
          velocity: note.velocity,
          midiGain: channelVolume * expression,
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
    if (!this.notes.length || !this.ctx) return

    this.clearSources()
    // Volume is applied by the master gain so the slider works immediately.
    const samples = await this.renderMix(undefined, 1)
    const buffer = this.ctx.createBuffer(1, samples.length, EXPORT_SAMPLE_RATE)
    buffer.copyToChannel(samples, 0)

    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.outputGain)
    src.start(this.ctx.currentTime, this.pauseOffset / this.tempoScale)
    this.activeSources.push(src)
    this.playing = true
    this.startTime = this.ctx.currentTime
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
    return this.renderMix(onProgress)
  }

  /**
   * Render one complete mix for both downloads and browser playback. Playing
   * one buffer avoids dropping early notes while many Web Audio sources are
   * being created for dense MIDI files.
   * @param {(pct: number) => void} [onProgress]
   * @returns {Promise<Float32Array>}
   */
  async renderMix(onProgress, volume = this.volume) {
    if (!this.banks) throw new Error('Samples not loaded')

    return renderMix({
      notes: this.notes,
      banks: this.banks,
      pickKind: (note, index) => this.pickKind(note, index),
      rateForNote: (midi, kind) => this.rateForNote(midi, kind),
      durationSec: this.duration,
      volume,
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
