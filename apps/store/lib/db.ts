import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { config } from "./config";

// Times are unix seconds (BIGINT, which node-postgres returns as a string). Amounts are pathUSD
// base units as decimal TEXT. created_block is a decimal TEXT block number, so it round-trips
// through BigInt without loss. Transaction hashes are lowercase hex.
// Concurrent first queries on a fresh database would race CREATE ... IF NOT EXISTS in the
// catalog; the advisory lock, held for this one implicit transaction, serializes them.
const SCHEMA = `
SELECT pg_advisory_xact_lock(hashtext('reup-store-schema'));

CREATE TABLE IF NOT EXISTS verifications (
  verification_id TEXT PRIMARY KEY,
  tap_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  batch_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  vendor_name TEXT NOT NULL,
  coa_url TEXT NOT NULL,
  payer TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_attempts (
  tx_hash TEXT PRIMARY KEY,
  tap_id TEXT NOT NULL,
  payer TEXT NOT NULL,
  valid_before BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'dead', 'review')),
  created_block TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT,
  note TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_live_tap
  ON payment_attempts (tap_id) WHERE status IN ('pending', 'paid', 'review');

CREATE TABLE IF NOT EXISTS issued_challenges (
  challenge_id TEXT PRIMARY KEY,
  tap_id TEXT NOT NULL,
  amount TEXT NOT NULL,
  expires BIGINT NOT NULL,
  used_at BIGINT
);

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  tap_id TEXT NOT NULL UNIQUE,
  tx_hash TEXT NOT NULL UNIQUE,
  amount TEXT NOT NULL,
  payer TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
`;

// Next.js may evaluate this module once per bundle (instrumentation and each route),
// so the pool and the schema promise live on globalThis to stay single per process.
const processScope = globalThis as typeof globalThis & {
  reupStorePool?: Pool;
  reupStoreSchema?: Promise<void>;
};

function pool(): Pool {
  if (!processScope.reupStorePool) {
    // allowExitOnIdle lets a test or script exit once its queries finish.
    const created = new Pool({
      connectionString: config.databaseUrl,
      max: 3,
      allowExitOnIdle: true,
    });
    // Without a listener, an idle client dropped by the server crashes the process.
    created.on("error", (error) => console.error("postgres idle client error:", error.message));
    processScope.reupStorePool = created;
  }
  return processScope.reupStorePool;
}

async function createSchema(): Promise<void> {
  try {
    await pool().query(SCHEMA);
  } catch (error) {
    processScope.reupStoreSchema = undefined;
    throw error;
  }
}

/** Creates the schema once per process. A failed run is retried by the next caller. */
export function ensureSchema(): Promise<void> {
  processScope.reupStoreSchema ??= createSchema();
  return processScope.reupStoreSchema;
}

async function ready(): Promise<Pool> {
  await ensureSchema();
  return pool();
}

export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<QueryResult<R>> {
  return (await ready()).query(text, values);
}

export type Query = typeof query;

/**
 * Runs `work` on one checked-out client between BEGIN and COMMIT, rolling back if it throws.
 * Every query inside `work` must go through the `tx` it receives, never the pool.
 *
 * READ COMMITTED (the default) suffices: every racing write is either a conditional UPDATE,
 * which re-checks its WHERE against the committed row after waiting on a concurrent writer,
 * or an INSERT that a unique constraint guards. No transaction writes on the strength of a
 * row it read earlier without one of those guards.
 */
export async function transaction<T>(work: (tx: Query) => Promise<T>): Promise<T> {
  const client = await (await ready()).connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await work((text, values) => client.query(text, values));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch((rollbackError: Error) => {
      broken = rollbackError;
    });
    throw error;
  } finally {
    client.release(broken);
  }
}
