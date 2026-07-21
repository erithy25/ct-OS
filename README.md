# PANOPTICON // HOMEWATCH

A private, **local** home-awareness command center for your own property. Connect your
real cameras + your Mac webcam, watch them on one tactical wall, and let on-device
computer vision tell you what's happening — people, vehicles, packages, zone breaches,
and which household members are home. Everything runs on your machine; **nothing is
uploaded**.

> This began as a fictional city-operations simulation ("NOVA HARBOR", still in the repo
> under `src/sim` and `src/modules`). It has been repurposed into a real home system —
> the app entry (`src/main.tsx`) now renders `HomeApp`.

## What it does — and what it deliberately doesn't

**It does:** bridge your real cameras to a live wall; run on-device detection
(person / vehicle / animal / package); let you draw **property zones** and alert when
someone enters; enroll your **own household** (with consent) so faces read as
**KNOWN _name_** vs **UNKNOWN**; track who's home; build an activity timeline and simple
learned routines; and push local alerts / browser notifications for unknown visitors and
zone breaches.

**It doesn't — by design:** decide whether someone "could be a criminal." You cannot see
criminality in a camera image, and trying to would falsely accuse innocent people. The
honest, genuinely-useful version is **KNOWN vs UNKNOWN** (is this someone your system
recognizes?) combined with **behavior** (did they enter your property, at night?). That
is what real home security does, and it's what HOMEWATCH does.

## Privacy (built in)

- **Local-only.** Cameras are bridged by a server running on *your* Mac; CV runs in your
  browser. No cloud, no upload, no account.
- **Consent.** Only enroll household members who agree. Face data is stored locally and is
  deletable at any time.
- **Your property only.** Point cameras at what you're entitled to watch; use `IGNORE`
  zones to exclude a street or a neighbor's land.

## Run it (on your Mac)

Requires Node ≥ 20, pnpm, and **ffmpeg** for bridging IP cameras (`brew install ffmpeg`).
First run of detection downloads the CV models once (cached); without them it degrades to a
clear `DETECTION OFFLINE` badge and the rest of the app keeps working.

```sh
pnpm install
pnpm server      # the HOMEWATCH server on http://127.0.0.1:8787  (cameras + status)
pnpm dev         # the cockpit on http://localhost:5173
```

Open `http://localhost:5173`, allow camera access for CAM-01 (your webcam), then
**+ ADD CAMERA** and paste an IP-camera URL:

```
rtsp://user:pass@192.168.1.50:554/stream     # most IP / security cameras
http://192.168.1.51/video.mjpg               # MJPEG / HLS streams
test                                         # a built-in test pattern to try it
```

The server reads the stream with ffmpeg and re-streams it to the browser — nothing leaves
your machine.

## Modules

| Module | What it does |
| --- | --- |
| **LIVE WALL** | Every camera (webcam + bridged IP cameras) as a tile grid with live detection boxes, add/remove, expand. |
| **PEOPLE** | Enroll household members (consented, local); live KNOWN-vs-UNKNOWN face labeling; who's home. |
| **ZONES** | Draw property / entry / driveway regions per camera; alert when a person enters an armed zone (with night-only + known-person options). |
| **ACTIVITY** | Filterable event timeline, per-person presence, and a simple learned-routine histogram from your own history. |
| **ALERTS** | Alert center for unknown visitors + zone breaches, a rules summary, and browser push notifications. |

Keyboard: `1–5` switch modules · `⌘K` command (add/remove/goto) · `Esc` closes overlays.
Append `?boot=skip` to skip the boot sequence, `?api=http://host:port` to point at a
non-default server.

## How it works

A small **local server** (Node, `server/`) bridges each camera: it spawns one `ffmpeg`
per source (rtsp/http/file/test), splits the JPEG frames, and fans them out to browser
tiles as multipart MJPEG (`/api/cameras/:id/stream`). The **client** (Vite + React +
Zustand) polls the server for the camera list/status, renders the wall, and runs
**on-device** object detection (TensorFlow.js / COCO-SSD) round-robin across tiles, plus
**face recognition** (face-api.js) on the webcam for household matching. Zones are
normalized polygons tested against the "feet" of each person box; a background watcher
raises debounced breach events. All state (people, zones, events) lives locally in the
browser; the only thing the server holds is the live camera bridges.

## Tech stack

Vite · React 18 · TypeScript (strict) · Tailwind (CSS-variable tokens) · Zustand ·
Framer Motion · TensorFlow.js + COCO-SSD (on-device detection) · face-api.js (local face
recognition) · a Node + ffmpeg camera-bridge server. No paid APIs, no cloud.

## Safety & scope

HOMEWATCH is for **your own** cameras, property, and household. It provides situational
awareness and known/unknown recognition — never a judgement about a person's character.
It does not, and should not, connect to public infrastructure or surveil people beyond
your property.
