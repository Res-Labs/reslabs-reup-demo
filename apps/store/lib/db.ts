import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config";

// Times are unix seconds. Amounts are pathUSD base units as decimal TEXT.
// created_block is a decimal TEXT block number, so it round-trips through BigInt without loss.
// Transaction hashes are lowercase hex.
const SCHEMA = `
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
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_attempts (
  tx_hash TEXT PRIMARY KEY,
  tap_id TEXT NOT NULL,
  payer TEXT NOT NULL,
  valid_before INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'dead', 'review')),
  created_block TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  note TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_live_tap
  ON payment_attempts(tap_id) WHERE status IN ('pending', 'paid', 'review');

CREATE TABLE IF NOT EXISTS issued_challenges (
  challenge_id TEXT PRIMARY KEY,
  tap_id TEXT NOT NULL,
  amount TEXT NOT NULL,
  expires INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  tap_id TEXT NOT NULL UNIQUE,
  tx_hash TEXT NOT NULL UNIQUE,
  amount TEXT NOT NULL,
  payer TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

// Next.js may evaluate this module once per bundle (instrumentation and each route),
// so the handle lives on globalThis to keep a single connection per process.
const processScope = globalThis as typeof globalThis & { reupStoreDb?: Database.Database };

export function db(): Database.Database {
  if (!processScope.reupStoreDb) {
    mkdirSync(path.dirname(config.storeDbPath), { recursive: true });
    const handle = new Database(config.storeDbPath);
    handle.pragma("journal_mode = WAL");
    handle.pragma("busy_timeout = 5000");
    handle.exec(SCHEMA);
    processScope.reupStoreDb = handle;
  }
  return processScope.reupStoreDb;
}
