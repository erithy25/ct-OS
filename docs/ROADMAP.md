# PANOPTICON // OS — from simulation to real

This is the plan for turning the fully-simulated cockpit into a real, deployable
application — starting locally on a Mac. It's staged so every step keeps the app
green and shippable.

## The load-bearing idea

The entire UI reads from one contract: `useSim` (reactive scalars) plus
`getWorld()` / `getEvents()` / `getHistories()` (imperative, non-reactive). No
module knows *where* the data comes from. So "going real" means replacing the
**producer** behind that contract — not rewriting the map, graph, or charts.

Phase 0 makes that seam real. Everything after it is "add another adapter."

---

## Phase 0 — Foundation ✅ DONE

Decoupled the UI from the simulation producer behind a wire protocol. The
authoritative world now runs in a **Web Worker** (off the render thread) by
default, can fall back to the **main thread**, or connect to a **node server**
over WebSocket — all behind the same `WorldSource` interface, with zero module
changes.

- `src/realtime/protocol.ts` — JSON-safe `hello` / `tick` / `command` messages;
  the `WorldSource` + `EngineHost` contracts. One protocol, three transports.
- `src/realtime/engineHost.ts` — the single authoritative world owner
  (browser-API-free, so node imports it too). Wraps `createWorld` /
  `advanceWorld`, serialises snapshots + per-tick deltas, captures engine
  events, applies commands.
- `src/realtime/sources/` — `WorkerSource` (default), `InlineSource` (fallback /
  tests / single-file), `RemoteSource` (WebSocket, reconnect + backoff +
  command queue).
- `src/sim/store.ts` — rewired as a **mirror world** driven by
  `applyHello`/`applyTick`. Actions do an optimistic reactive echo, then forward
  a command to the source. The exported contract is unchanged.
- `server/` — a local node server (fastify/ws + `better-sqlite3` + zod) that runs
  the same `EngineHost`, streams to browsers, accepts commands, and **persists**
  rolling histories + recent events across restarts.

Switch transports at runtime:

| URL | Producer |
| --- | --- |
| default | `WorkerSource` — engine in a Web Worker |
| `?source=inline` | `InlineSource` — engine on the main thread |
| `?source=remote` | `RemoteSource` — connect to the node server (`?ws=` to override) |

```sh
pnpm dev                 # cockpit, worker source
pnpm server              # node server on ws://127.0.0.1:8787/ws
# then open http://localhost:5173/?source=remote
pnpm test                # 110 tests incl. the realtime layer
```

The `EngineHost` is deterministic (same seed → identical ticks), so the worker,
the inline host, and the server all produce the same NOVA HARBOR.

---

## Phase 1 — First real feed ✅ DONE

The whole chain *real source → producer → transport → store → existing UI* now
carries genuine data. The `EngineHost` accepts real telemetry via the existing
`command` channel (`{ k:'feed' }`), overlays it on the wire `derived`, and
**real CPU genuinely drives the city's "CPU load."** No UI was restructured —
the vitals just became partly real, plus one clearly-labelled `● REAL` readout.

- `src/realtime/dataFeed.ts` — the **operator node** feed: real render FPS,
  JS-heap %, network downlink/RTT, logical cores, device memory, online state,
  and a main-thread load proxy from real event-loop lag. Runs in every mode
  (worker / inline / remote), fully guarded off-browser.
- `server/src/hostFeed.ts` — the **host** feed (remote mode): the real machine's
  CPU / memory / network via `systeminformation`, pushed into the server's
  EngineHost. In `?source=remote` the cockpit shows the actual server host's
  load, and `CITY LOAD ◆` reflects it.
- `EngineHost` keeps telemetry by origin (`client` / `host`), announces first
  contact on the `FEED` event channel, and exposes `derived.realTelemetry`.
- UI: an `OPERATOR NODE ● REAL` block in the left rail (host sub-panel appears in
  remote mode); `CITY LOAD ◆` marks real augmentation. 8 realtime tests.

This is the template for every future feed: implement a sampler, send
`{ k:'feed' }`, done — the UI never changes.

## Phase 2 — Market-ops domain layer ✅ DONE

Chosen domain: **finance / market ops** (on-brand, no privacy surface, real
keyless data). A market dimension now lives on the same seam — real when the
server runs, deterministically simulated otherwise, always clearly badged.

- `src/sim/markets.ts` — a 12-instrument crypto/USD basket, a deterministic GBM
  simulator (worker/inline), the Kraken result-key mapping, and a market-stress
  index.
- `EngineHost` holds instruments, steps the sim each tick, accepts real quotes
  via `injectMarket()` (overlays matching symbols → `source:'live'`), emits
  volatility events on sharp moves, and exposes `marketStress` / `marketSource`.
- `server/src/marketFeed.ts` — polls **Kraken's public Ticker API** (keyless,
  global `fetch`, fully guarded) every 5s and injects real quotes. `?source=remote`
  shows live exchange prices.
- `src/modules/markets/` — the **MARKET OPS** center-stage board: sortable
  12-row live grid with trend sparklines, an instrument-detail chart with
  range/microstructure, a movers/breadth rail, a market-stress gauge, and
  `● LIVE · REAL EXCHANGE` / `◐ SIMULATED` honesty everywhere (real volume only
  when live). Wired into nav (key `6`), `⌘K goto markets`, and the center stage.

Verified end-to-end: worker mode runs the deterministic simulator; remote mode
streams real Kraken prices (DOT +4.01%, BTC ~$66.5k, real 24h volume). The city
ops modules remain — this is an additive domain view, not a teardown.

### Not yet (future Phase 2+ ideas)
Deeper coupling (market stress → DEFCON input), a real OSM basemap for the
tactical view, a counterparty/exposure graph in the profiler, and equities via a
keyed feed. The seam makes each of these "add an adapter," not a rewrite.

## Phase 3 — Harden into a product

Auth (single-user: keychain), typed API contracts (zod end-to-end),
reconnect/health/observability, per-adapter tests, Docker, a deploy target.

## Phase 4 — Optional consented CV

The webcam stays local-only. Any biometric extension is strict opt-in
(self-enrollment, on-device, deletable) — never public-facing surveillance.

---

## The one hard line

The people/biometric surveillance mechanics stay **synthetic or strictly
opt-in**. No real facial-recognition database, no location tracking of real
non-consenting people, no relationship graphs of real private individuals.
Biometrics are GDPR/DSGVO Art. 9 special-category data and public facial
recognition is effectively prohibited — keeping this layer fictional is what
keeps the app demoable and deployable. In the finance domain the surface
disappears entirely (there are no persons).
