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

## Phase 1 — First real feed (next)

Prove the whole chain *real source → server → WS → store → existing UI* with the
smallest possible feed. The `EngineHost` gains an optional **DataSource** input;
one real value flows into the existing vitals/charts. Nothing in the UI changes.

- Safest first feed (offline): the Mac's own system metrics (`systeminformation`)
  → System Vitals.
- Domain-specific alternative — see below.

## Phase 2 — Domain semantics + real map/graph (forks by domain)

The world model repoints at a chosen domain. The entity taxonomy
(person/vehicle/incident/camera) and the map layer become domain-shaped; the
Gotham/Bloomberg aesthetic stays. Candidate domains: **finance/market ops**
(instruments, limit breaches, counterparty graph, exposure map — no privacy
surface), **homelab/infrastructure** (real host & service metrics), or
**public city data** (GTFS-RT transit, traffic, weather on a real OSM map).

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
