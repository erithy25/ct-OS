# PANOPTICON // OS

A local, single-user, **fully-simulated** city-operations-center dashboard — a tactical
surveillance & infrastructure-command cockpit in the visual language of Palantir Gotham,
Watch Dogs' ctOS, and a Bloomberg terminal.

**Everything on screen is fiction.** The city ("NOVA HARBOR"), every citizen, vehicle,
incident, camera and infrastructure system is procedurally generated in memory from a
seed. There is no backend, no network calls about people, no real data source of any
kind. Every identity record carries a `SOURCE: SIMULATED` tag in the UI. The single
real input is **your own webcam**, processed entirely in your browser (TensorFlow.js +
MediaPipe) and never uploaded anywhere — and even its "identity match" sequence is
clearly-labeled theater drawing from the fictional identity factory.

This is a design/engineering showcase, not a surveillance tool.

## Run it

Requires Node ≥ 20 and pnpm. First launch of the Surveillance module downloads the
CV models once (they're cached; without network the module degrades to a `CV OFFLINE`
badge and the rest of the app is unaffected).

```sh
pnpm install
pnpm dev        # → http://localhost:5173
pnpm test       # vitest: PRNG determinism, incident FSM, city generation, world smoke
pnpm build      # strict tsc + production bundle
```

Best experienced in Chrome at ≥1440×900. Allow camera access for the CAM-01 feed and
biometric mode; deny it and you get a graceful `NO SIGNAL // PERMISSION DENIED` state.

## The cockpit

```
┌───────────────────────────────────────────────────────────────────────┐
│  TOP BAR   product mark · UTC/local/sim clocks · OP badge · DEFCON · ⌘K │
├──────────┬──────────────────────────────────────────────┬─────────────┤
│ LEFT RAIL│                CENTER STAGE                  │ INTEL COLUMN │
│ modules +│    MAP / SURVEILLANCE / PROFILER /           │ alert feed   │
│ vitals   │    INFRASTRUCTURE / OPS DECK                 │ dossier      │
│          │                                              │ telemetry    │
├──────────┴──────────────────────────────────────────────┴─────────────┤
│  TICKER    scrolling event log · TICK # · FPS · LATENCY                │
└───────────────────────────────────────────────────────────────────────┘
```

| Module | What it does |
| --- | --- |
| **TACTICAL MAP** | Canvas-rendered procedural city with ~450 live entities (vehicles, persons of interest, patrol units, incidents, camera FOV cones), pan/zoom, minimap, and toggleable overlays: `HEATMAP` (violet predictive), `TRAFFIC`, `POWER`, `FOV`, `UNITS`. Infrastructure actions visibly reshape it. |
| **SURVEILLANCE** | Camera wall. CAM-01 is your real webcam with live COCO-SSD object detection (corner-bracket boxes, confidence bars) and a **biometric mode**: MediaPipe 468-point face mesh + a clearly-labeled `SIMULATED MATCH` identity-resolution sequence. Other tiles are procedural feeds tied to city cameras — black out their sector and they drop to `SIGNAL LOST`. |
| **PROFILER** | Gotham-style link-analysis graph (d3-force). Pull the thread on any person: associates, phones, vehicles, accounts, locations with typed edges, 1–3 hops, search, and PNG export. Deterministic per entity. |
| **INFRASTRUCTURE** | Own the city: per-sector power breakers (hold-to-confirm blackout), traffic signal control, metro lines, drawbridges, comms. Consequences are simulated — blackouts kill cameras, snarl traffic, and spike incidents. A SYSTEM INTEGRITY readout warns of cascade risk. |
| **OPS DECK** | Bloomberg-dense analytics: six live strip charts, a sortable threat board (click through to the profiler), a violet predictive panel with next-hour hotspot forecasts + templated analyst notes, and a virtualized, filterable event-log table. |

## ⌘K command terminal

Fuzzy palette + typed grammar with inline autocomplete, history (↑/↓), and event-log
echo. Cheat sheet:

```
goto map|grid|graph|infra|ops      switch modules
locate <ENTITY-ID>                 fly the map to an entity and select it
track <ID> / untrack <ID>          toggle tracking (pulsing ring + follow)
dossier <ENTITY-ID>                open the profiler / dossier for an entity
blackout <SECTOR-ID>               cut a sector's power        (restore <SECTOR-ID>)
restore all                        auto-restore every system
traffic <SECTOR-ID> green|red|normal
bridge <NAME> raise|lower          e.g. bridge kessler span raise
scan biometric                     jump to CAM-01 biometric mode
spawn incident [SECTOR-ID]         inject a fictional incident
defcon <1-5>                       threat-level override (run twice to confirm)
defcon clear                       return DEFCON to sim-derived
theme · mute · help                utilities
```

Keyboard: `1–5` switch modules · `Esc` closes overlays / deselects · `Esc` during boot skips it.
Append `?boot=skip` to the URL to skip the boot sequence.

## How the simulation works

A seeded PRNG (mulberry32, seed `0x2F7A`) deterministically generates NOVA HARBOR — nine
districts, a harbor and river, a 400-node road graph with three raisable bridges, city
blocks, landmarks, and 24 sensor cameras — then populates it with 260 fictional persons,
150 vehicles and 12 patrol units that pathfind (A*) along the roads under a 10 Hz logic
tick (renderers interpolate between ticks at 60 fps). Cameras raycast their FOV cones and
emit detection events; incidents spawn via a Poisson process weighted by district risk,
the day/night cycle (sim time runs 10×), and the instability *you* cause from the
infrastructure board — blackouts kill cameras, stall traffic and raise incident
probability, which feeds the risk index, the DEFCON derivation, the violet hotspot
forecast, and the templated analyst notes. Identities are generated on demand from token
lists keyed by entity id, so every dossier and relationship graph is reproducible — and
none of it resembles any real person or place.

## Tech stack

Vite · React 18 · TypeScript (strict) · Tailwind (CSS-variable design tokens) ·
Zustand (reactive scalars + a non-reactive mutable world) · Framer Motion · D3
(`d3-force`/`d3-zoom`/`d3-drag`) · TensorFlow.js + coco-ssd · MediaPipe Tasks Vision
(FaceLandmarker) · cmdk · Web Audio. No paid APIs, no map tiles, no keys.

## Guardrails

- No real personal-data source, facial-recognition database, surveillance feed, or
  geolocation of real people is integrated — and none should ever be.
- The webcam is processed locally in-browser only; nothing is transmitted or stored.
- All identities are procedural fiction from token lists, labeled `SOURCE: SIMULATED`.
