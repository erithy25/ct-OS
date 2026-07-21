/**
 * Server configuration — zod-validated, sourced from process.env with an
 * optional `.env` loaded via Node's built-in loader (no dotenv dependency).
 * Parse failures print a clear per-field message and exit(1).
 *
 * Fields:
 *   PORT          listen port                       (default 8787)
 *   HOST          bind address                      (default 127.0.0.1)
 *   SEED          world seed; hex (0x2F7A) or dec   (default DEFAULT_SEED)
 *   DB_PATH       sqlite file; relative → repo root (default server/data/panopticon.db)
 *   TICK_MS       sim step interval, ms             (default 100 → 10 Hz)
 *   SNAPSHOT_SEC  persistence cadence, seconds      (default 10)
 *   WS_PATH       websocket route                   (default /ws)
 */
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { DEFAULT_SEED } from '../../src/sim/cityGen'
import { DEFAULT_WS_PATH, DEFAULT_WS_PORT } from '../../src/realtime/protocol'

/** repo root = two levels up from server/src/config.ts */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Best-effort .env load (repo root first, then cwd). Node 22 ships loadEnvFile.
try {
  process.loadEnvFile?.(resolve(ROOT, '.env'))
} catch {
  try {
    process.loadEnvFile?.()
  } catch {
    /* no .env anywhere — fall back to the real environment */
  }
}

/** accept "0x2F7A" / "0X2f7a" (hex) or "12154" (decimal); blank → undefined */
const flexibleInt = (v: unknown): unknown => {
  if (typeof v === 'number') return v
  if (typeof v !== 'string') return v
  const s = v.trim()
  if (s === '') return undefined
  return /^[+-]?0x[0-9a-f]+$/i.test(s) ? parseInt(s, 16) : Number(s)
}

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_WS_PORT),
  HOST: z.string().min(1).default('127.0.0.1'),
  SEED: z.preprocess(flexibleInt, z.number().int().nonnegative()).default(DEFAULT_SEED),
  DB_PATH: z.string().min(1).default('server/data/panopticon.db'),
  TICK_MS: z.coerce.number().int().min(1).max(60000).default(100),
  SNAPSHOT_SEC: z.coerce.number().min(1).max(3600).default(10),
  WS_PATH: z.string().startsWith('/').default(DEFAULT_WS_PATH),
})

const parsed = ConfigSchema.safeParse(process.env)
if (!parsed.success) {
  console.error('[config] invalid server configuration:')
  for (const issue of parsed.error.issues) {
    console.error(`  · ${issue.path.join('.') || '(env)'}: ${issue.message}`)
  }
  process.exit(1)
}

const raw = parsed.data
const dbPath = isAbsolute(raw.DB_PATH) ? raw.DB_PATH : resolve(ROOT, raw.DB_PATH)

export interface ServerConfig {
  PORT: number
  HOST: string
  SEED: number
  /** absolute — resolved against the repo root when the env value is relative */
  DB_PATH: string
  TICK_MS: number
  SNAPSHOT_SEC: number
  WS_PATH: string
  ROOT: string
}

export const config: ServerConfig = {
  PORT: raw.PORT,
  HOST: raw.HOST,
  SEED: raw.SEED,
  DB_PATH: dbPath,
  TICK_MS: raw.TICK_MS,
  SNAPSHOT_SEC: raw.SNAPSHOT_SEC,
  WS_PATH: raw.WS_PATH,
  ROOT,
}
