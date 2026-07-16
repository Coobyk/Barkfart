# Barkfart

Turn a MIDI file into a chaotic bark-and-fart performance.

Upload a `.mid` or `.midi` file, choose a sound mode, then play it in the browser or export the result as WAV or MP3. All MIDI parsing, sample playback, mixing, and encoding happen locally in your browser.

## Features

- Load MIDI files or try the included demo
- Map notes to bark, fart, alternating, or automatic left/right-hand sounds
- Adjust playback speed and volume
- Export a rendered WAV or MP3 file
- No server or account required

## Run locally

Requires a recent version of Node.js.

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run build
```

## Tech

- Vite
- Web Audio API
- `@tonejs/midi`
- `@breezystack/lamejs`
