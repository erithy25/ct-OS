# @panopticon/server

Phase-0 realtime server for **PANOPTICON // OS**. It runs the authoritative
simulation producer (`EngineHost`) headless in Node, streams world state to
browser clients over WebSocket, accepts operator commands, and persists rolling
state to SQLite so the world survives restarts.

This streams the **same** deterministic simulation the browser runs standalone —
`EngineHost` is the single authoritative world owner used by all three transports
(worker / inline / node server). Running it server-side is the Phase-0 substrate
for wiring in real data feeds later: today the server *is* the producer; tomorrow
the same wire protocol carries live telemetry instead of the built-in sim, with
zero client changes.

## Run

From the repo root:

```bash
pnpm server          # start (production-ish: tsx src/index.ts)
pnpm server:dev      # watch mode (tsx watch)
pnpm typecheck:server
```

Or from inside `server/`:

```bash
pnpm start           # tsx src/index.ts
pnpm dev             # tsx watch src/index.ts
pnpm typecheck       # tsc --noEmit
```

On boot it logs a single structured line, e.g.:

```
PANOPTICON SERVER · ws://127.0.0.1:8787/ws · seed 0x2F7A · db /abs/path/server/data/panopticon.db · fresh start
```

…or `persisted <n> events / <m> history samples` once a prior run has been saved.

Health probe:

```bash
curl -s http://127.0.0.1:8787/health
# {"ok":true,"tick":123,"clients":0,"uptime":12}
```

## Configuration

Read from `process.env` (validated with zod). A `.env` at the repo root is loaded
automatically if present (Node's built-in loader — no dotenv dependency). Invalid
values print a per-field message and exit(1).

| Env var        | Default                      | Meaning                                                        |
| -------------- | ---------------------------- | -------------------------------------------------------------- |
| `PORT`         | `8787`                       | HTTP/WS listen port                                            |
| `HOST`         | `127.0.0.1`                  | Bind address                                                   |
| `SEED`         | `0x2F7A` (DEFAULT_SEED)      | World seed. Hex (`0x2F7A`) or decimal (`12154`).               |
| `DB_PATH`      | `server/data/panopticon.db`  | SQLite file. Relative paths resolve against the **repo root**. |
| `TICK_MS`      | `100`                        | Sim step interval → 10 Hz. Also the broadcast cadence.         |
| `SNAPSHOT_SEC` | `10`                         | How often rolling state is written to SQLite.                  |
| `WS_PATH`      | `/ws`                        | WebSocket route (must start with `/`).                         |

## Protocol

The full wire protocol is the binding contract in
[`src/realtime/protocol.ts`](../src/realtime/protocol.ts). Summary for a client
(`RemoteSource`):

- **Endpoint:** `ws://<HOST>:<PORT>/ws` (defaults `ws://127.0.0.1:8787/ws`,
  `PROTOCOL_VERSION = 1`).
- **Framing:** exactly **one JSON object per WebSocket message** — no length
  prefixes, no batching. `JSON.parse` each message and switch on `.t`.
- **On connect:** the server sends a `hello` (`HelloMsg`) **immediately** — the
  full snapshot: `city`, static `persons` (260) / `vehicles` / `patrols` /
  `cameras`, current `infra`, seeded `histories`, `recentEvents`, and `derived`.
- **Then:** a `tick` (`TickMsg`) every `TICK_MS` (~10/sec) with interleaved
  `personPos`/`vehiclePos`/`patrolPos` `[x0,y0,x1,y1,…]` (hello order,
  `POS_DECIMALS`-rounded), per-entity sector/flags/status arrays, the full
  `incidents` list, camera state, `congestion`, `derived`, and any `events`
  emitted during that tick. A tick carries `infra` **only** on ticks where a
  command changed infra state (acts as the ack).
- **Client → server:** a single `CommandMsg` `{ t:'cmd', v:1, cmd:<SourceCommand> }`
  per message. The server validates with `isCommandMsg` + a zod schema and
  applies it to authoritative state; the change surfaces on a subsequent tick.
  Malformed commands are logged and dropped — never fatal.

Example command (cut power to a sector):

```json
{ "t": "cmd", "v": 1, "cmd": { "k": "power", "sector": "SECTOR-1", "on": false } }
```

## Persistence

better-sqlite3, at `DB_PATH` (WAL). Three tables: `meta` (seed, savedAt),
`histories` (single row, the 7 rolling series as JSON), and `events` (recent
`WireEvent` tail, capped at 500). State is saved every `SNAPSHOT_SEC` and on
graceful shutdown; on boot it is reloaded only if the stored seed matches the
configured `SEED` (otherwise: fresh start). **Every** SQLite call is wrapped —
any DB failure logs a warning and the server continues in-memory; persistence is
never allowed to crash the daemon.
