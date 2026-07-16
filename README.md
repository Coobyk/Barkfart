# Barkfart

Upload a MIDI file, play it as **dog barks** and **farts**, download as **MP3**.

**100% client-side** — no backend. MIDI parse, sample playback, offline mix, and MP3 encode all run in the browser. Safe for **GitHub Pages**.

## What is barkfart?

An internet meme remix style: take a song (often via MIDI) and re-voice every note with bark and fart samples. Popular in joke GarageBand / FL Studio remixes.

## Features

- Drag-and-drop MIDI (`.mid` / `.midi`)
- Real `bark.mp3` / `fart.mp3` samples (pitch-shifted per note)
- Modes: auto (bass → fart, lead → bark), all barks, all farts, alternate
- Play / pause / seek
- Fast offline mix + **MP3 / WAV download** (client-side)
- Nothing is uploaded to a server

## Develop

```bash
npm install
npm run dev
```

## Build (static site)

```bash
npm run build
# output → dist/  (upload this folder anywhere static hosting works)
npm run preview
```

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push to `main` (or `master`), or run the **Deploy to GitHub Pages** workflow manually.
4. Site URL will be something like:  
   `https://<user>.github.io/Barkfart/`

The workflow in `.github/workflows/deploy.yml` builds with Vite (`base: './'`) and deploys `dist/`.  
`public/.nojekyll` is included so GitHub does not run Jekyll on the site.

### Manual deploy (optional)

```bash
npm run build
# then publish the dist/ folder with any static host or gh-pages
```

## Samples

Keep `bark.mp3` and `fart.mp3` in `public/` (copied into `dist/` on build).

## Stack

- Vite (static SPA, relative asset base for project pages)
- [@tonejs/midi](https://github.com/Tonejs/Midi) — MIDI parse
- Web Audio API — sample playback, pitch shift, offline render
- [@breezystack/lamejs](https://www.npmjs.com/package/@breezystack/lamejs) — MP3 encode in-browser
