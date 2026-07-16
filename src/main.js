import './style.css'
import { publicUrl } from './base.js'
import { BarkfartPlayer, formatTime } from './player.js'
import {
  encodeMp3,
  encodeWav,
  downloadBlob,
  EXPORT_SAMPLE_RATE,
} from './exportAudio.js'

const player = new BarkfartPlayer()
let fileBaseName = 'barkfart'
let meta = null

const app = document.querySelector('#app')

app.innerHTML = `
  <header class="hero">
    <div class="hero-emoji" aria-hidden="true">🐶💨</div>
    <h1>Barkfart</h1>
    <p>
      Upload a MIDI file and hear every note as a <strong>dog bark</strong> or a <strong>fart</strong>.
      Then download your masterpiece as MP3.
    </p>
    <span class="tag">MIDI → barkfart → MP3</span>
  </header>

  <section class="card">
    <h2>1. Drop a MIDI</h2>
    <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Upload MIDI file">
      <input type="file" id="file" accept=".mid,.midi,audio/midi,audio/x-midi" />
      <div class="icon">🎹</div>
      <strong>Drop a .mid file here</strong>
      <span>or click to browse</span>
    </div>
    <div class="controls" style="margin-top: 0.75rem">
      <button type="button" class="secondary" id="demo">Try demo scale</button>
    </div>
    <div class="file-meta" id="meta"></div>
    <p class="error" id="error" hidden></p>
  </section>

  <section class="card">
    <h2>2. Sound mode</h2>
    <div class="options">
      <div class="field">
        <label>Instrument mapping</label>
        <div class="mode-pills" id="modes">
          <button type="button" data-mode="auto" class="active">Piano hands (LH fart / RH bark)</button>
          <button type="button" data-mode="bark">All barks 🐶</button>
          <button type="button" data-mode="fart">All farts 💨</button>
          <button type="button" data-mode="alternate">Alternate</button>
        </div>
      </div>
      <div class="field">
        <label for="splitMidi">Hand split — below = fart, at/above = bark</label>
        <div class="slider-row">
          <input type="range" id="splitMidi" min="36" max="84" value="60" />
          <span class="val" id="splitMidiVal">C4 (60)</span>
        </div>
      </div>
      <div class="field">
        <label for="volume">Volume</label>
        <div class="slider-row">
          <input type="range" id="volume" min="0" max="100" value="85" />
          <span class="val" id="volumeVal">85%</span>
        </div>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>3. Play</h2>
    <div class="transport">
      <div class="viz" id="viz" aria-hidden="true">
        ${Array.from({ length: 24 }, () => '<span></span>').join('')}
      </div>
      <input type="range" class="seek" id="seek" min="0" max="1000" value="0" disabled />
      <div class="transport-row">
        <button type="button" id="play" disabled>▶ Play</button>
        <button type="button" class="secondary" id="stop" disabled>■ Stop</button>
        <span class="time" id="time">0:00 / 0:00</span>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>4. Download</h2>
    <p class="hint">Mixes in your browser (no upload). MP3 is mono 22&nbsp;kHz for speed; WAV is instant after mix.</p>
    <div class="controls" style="margin-top: 0.85rem">
      <button type="button" id="download" disabled>⬇ Download MP3</button>
      <button type="button" class="secondary" id="downloadWav" disabled>⬇ Download WAV</button>
    </div>
    <div class="progress-bar" id="exportProgress"><i></i></div>
    <div class="export-status" id="exportStatus"></div>
  </section>

  <footer>
    <p class="about">
      <strong>What is barkfart?</strong>
      An internet meme remix style where music is rebuilt with dog barks and fart samples —
      popular in GarageBand / FL Studio joke remixes (think Touhou or PPAP, but ruder).
    </p>
    <p style="margin-top: 0.75rem">Runs fully in your browser. No server. No dignity.</p>
  </footer>
`

// Elements
const dropzone = document.getElementById('dropzone')
const fileInput = document.getElementById('file')
const metaEl = document.getElementById('meta')
const errorEl = document.getElementById('error')
const playBtn = document.getElementById('play')
const stopBtn = document.getElementById('stop')
const seekEl = document.getElementById('seek')
const timeEl = document.getElementById('time')
const vizEl = document.getElementById('viz')
const downloadBtn = document.getElementById('download')
const downloadWavBtn = document.getElementById('downloadWav')
const exportStatus = document.getElementById('exportStatus')
const exportProgress = document.getElementById('exportProgress')
const splitMidiEl = document.getElementById('splitMidi')
const volumeEl = document.getElementById('volume')
let exporting = false

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
function midiToName(m) {
  const n = Math.round(m)
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`
}

function setError(msg) {
  if (!msg) {
    errorEl.hidden = true
    errorEl.textContent = ''
    return
  }
  errorEl.hidden = false
  errorEl.textContent = msg
}

function setReady(ready) {
  playBtn.disabled = !ready
  stopBtn.disabled = !ready
  seekEl.disabled = !ready
  downloadBtn.disabled = !ready || exporting
  downloadWavBtn.disabled = !ready || exporting
}

function setExportProgress(pct) {
  exportProgress.classList.add('visible')
  exportProgress.querySelector('i').style.width = `${Math.max(0, Math.min(100, pct))}%`
}

function updateTimeUI(t, dur) {
  timeEl.textContent = `${formatTime(t)} / ${formatTime(dur)}`
  if (dur > 0 && document.activeElement !== seekEl) {
    seekEl.value = String(Math.round((t / dur) * 1000))
  }
}

player.onProgress = (t, dur) => updateTimeUI(t, dur)
player.onEnded = () => {
  playBtn.textContent = '▶ Play'
  vizEl.classList.remove('playing')
}

async function loadFile(file) {
  if (!file) return
  setError('')
  const name = file.name || 'track.mid'
  if (!/\.midi?$/i.test(name) && file.type && !file.type.includes('midi')) {
    // still try — some systems omit type
  }

  fileBaseName = name.replace(/\.midi?$/i, '') || 'barkfart'
  try {
    const buf = await file.arrayBuffer()
    meta = await player.loadMidi(buf)
    metaEl.classList.add('visible')
    metaEl.innerHTML = `
      <div class="name">${escapeHtml(meta.name || name)}</div>
      <div>${meta.noteCount} notes · ${meta.tracks} tracks · ~${meta.bpm.toFixed(0)} BPM · ${formatTime(meta.duration)}</div>
    `
    setReady(meta.noteCount > 0)
    updateTimeUI(0, meta.duration)
    playBtn.textContent = '▶ Play'
    vizEl.classList.remove('playing')
    if (meta.noteCount === 0) {
      setError('That MIDI has no notes to bark or fart with.')
    }
  } catch (e) {
    console.error(e)
    setReady(false)
    metaEl.classList.remove('visible')
    setError('Could not parse that file. Please drop a valid .mid / .midi file.')
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Dropzone
;['dragenter', 'dragover'].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault()
    dropzone.classList.add('dragover')
  })
})
;['dragleave', 'drop'].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault()
    dropzone.classList.remove('dragover')
  })
})
dropzone.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0]
  if (f) loadFile(f)
})
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0]
  if (f) loadFile(f)
})

document.getElementById('demo').addEventListener('click', async () => {
  try {
    setError('')
    const res = await fetch(publicUrl('demo.mid'))
    if (!res.ok) throw new Error('Demo MIDI missing')
    const blob = await res.blob()
    const file = new File([blob], 'demo.mid', { type: 'audio/midi' })
    await loadFile(file)
  } catch (e) {
    console.error(e)
    setError('Could not load demo MIDI.')
  }
})

// Modes
document.getElementById('modes').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]')
  if (!btn) return
  document.querySelectorAll('#modes button').forEach((b) => b.classList.remove('active'))
  btn.classList.add('active')
  player.mode = btn.dataset.mode
  // Reschedule if playing
  if (player.playing) {
    const t = player.getCurrentTime()
    player.pause()
    player.pauseOffset = t
    player.play()
  }
})

splitMidiEl.addEventListener('input', () => {
  const v = Number(splitMidiEl.value)
  document.getElementById('splitMidiVal').textContent = `${midiToName(v)} (${v})`
  player.splitMidi = v
  // Reschedule if playing so the new split applies immediately
  if (player.playing) {
    const t = player.getCurrentTime()
    player.pause()
    player.pauseOffset = t
    player.play()
  }
})

volumeEl.addEventListener('input', () => {
  const v = Number(volumeEl.value)
  document.getElementById('volumeVal').textContent = `${v}%`
  player.volume = v / 100
})

// Transport
playBtn.addEventListener('click', async () => {
  try {
    if (player.playing) {
      player.pause()
      playBtn.textContent = '▶ Play'
      vizEl.classList.remove('playing')
    } else {
      await player.play()
      playBtn.textContent = '⏸ Pause'
      vizEl.classList.add('playing')
    }
  } catch (e) {
    console.error(e)
    setError(
      e?.message?.includes('bark') || e?.message?.includes('fart')
        ? 'Could not load bark.mp3 / fart.mp3 from /public. Check those files exist.'
        : 'Audio failed to start. Try clicking play again.',
    )
  }
})

stopBtn.addEventListener('click', () => {
  player.stop()
  playBtn.textContent = '▶ Play'
  vizEl.classList.remove('playing')
})

seekEl.addEventListener('input', () => {
  if (!meta) return
  const t = (Number(seekEl.value) / 1000) * meta.duration
  updateTimeUI(t, meta.duration)
})

seekEl.addEventListener('change', () => {
  if (!meta) return
  const t = (Number(seekEl.value) / 1000) * meta.duration
  player.seek(t)
  if (player.playing) {
    playBtn.textContent = '⏸ Pause'
    vizEl.classList.add('playing')
  }
})

// Download
async function runExport(format) {
  if (!meta || exporting) return
  exporting = true
  setReady(true)
  setError('')
  setExportProgress(0)
  exportStatus.className = 'export-status busy'
  exportStatus.textContent = 'Mixing barkfart…'

  try {
    if (player.playing) {
      player.pause()
      playBtn.textContent = '▶ Play'
      vizEl.classList.remove('playing')
    }

    const samples = await player.renderForExport((pct) => {
      setExportProgress(pct)
      exportStatus.textContent = `Mixing… ${Math.round(pct)}%`
    })

    let blob
    let filename
    if (format === 'wav') {
      exportStatus.textContent = 'Writing WAV…'
      setExportProgress(96)
      blob = encodeWav(samples, EXPORT_SAMPLE_RATE)
      filename = `${fileBaseName}-barkfart.wav`
      setExportProgress(100)
    } else {
      exportStatus.textContent = 'Encoding MP3…'
      setExportProgress(92)
      try {
        blob = await encodeMp3(samples, EXPORT_SAMPLE_RATE, (pct) => {
          setExportProgress(pct)
          exportStatus.textContent = `Encoding MP3… ${Math.round(pct)}%`
        })
        filename = `${fileBaseName}-barkfart.mp3`
      } catch (mp3Err) {
        console.warn('MP3 encode failed, falling back to WAV', mp3Err)
        blob = encodeWav(samples, EXPORT_SAMPLE_RATE)
        filename = `${fileBaseName}-barkfart.wav`
        exportStatus.className = 'export-status busy'
        exportStatus.textContent = 'MP3 failed — downloading WAV instead…'
      }
    }

    downloadBlob(blob, filename)
    exportStatus.className = 'export-status done'
    exportStatus.textContent = `Done — ${filename}`
    setExportProgress(100)
  } catch (e) {
    console.error(e)
    exportStatus.className = 'export-status'
    exportStatus.textContent = ''
    setError(`Export failed: ${e.message || e}`)
  } finally {
    exporting = false
    setReady(!!meta?.noteCount)
    setTimeout(() => {
      exportProgress.classList.remove('visible')
    }, 2500)
  }
}

downloadBtn.addEventListener('click', () => runExport('mp3'))
downloadWavBtn.addEventListener('click', () => runExport('wav'))
