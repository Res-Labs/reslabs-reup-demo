import { resolve } from "node:path";
import {
  type Address,
  type Attempt,
  createChainProof,
  type Hex,
  PATH_USD,
  type Resolution,
} from "@reup/chain-proof";
import Database from "better-sqlite3";
import { isAddress, parseUnits } from "viem";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`reconcile: ${name} is required (set it in .env)`);
    process.exit(1);
  }
  return value;
}

function parseAddress(name: string, value: string): Address {
  if (!isAddress(value, { strict: false })) {
    console.error(`reconcile: ${name} must be a 0x-prefixed 20-byte address, got "${value}"`);
    process.exit(1);
  }
  return value as Address;
}

function parseAmount(name: string, value: string): bigint {
  try {
    return parseUnits(value, 6);
  } catch {
    console.error(`reconcile: ${name} must be a decimal amount, got "${value}"`);
    process.exit(1);
  }
}

const rpcUrl = requireEnv("TEMPO_RPC_URL");
const recipient = parseAddress("MPP_RECIPIENT", requireEnv("MPP_RECIPIENT"));
const amount = parseAmount("DEMO_PRICE", requireEnv("DEMO_PRICE"));
// STORE_DB_PATH is shared via the root .env and is relative to the store's cwd, not the repo root.
const dbPath = resolve("apps/store", process.env.STORE_DB_PATH?.trim() || "data/store.db");

interface AttemptRow {
  tx_hash: string;
  tap_id: string;
  payer: string;
  valid_before: number;
  status: "pending" | "review";
  created_block: string | number | bigint;
  note: string | null;
}

let db: Database.Database;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch (err) {
  console.error(`reconcile: cannot open store DB at ${dbPath}: ${(err as Error).message}`);
  process.exit(1);
}

const rows = db
  .prepare(
    "SELECT tx_hash, tap_id, payer, valid_before, status, created_block, note FROM payment_attempts WHERE status IN ('pending', 'review') ORDER BY created_at",
  )
  .safeIntegers(false)
  .all() as AttemptRow[];
db.close();

if (rows.length === 0) {
  console.log("No pending or review attempts.");
  process.exit(0);
}

function describe(resolution: Resolution): string {
  switch (resolution.kind) {
    case "settled-paid":
    case "settled-no-transfer":
    case "reverted-no-transfer":
      return `${resolution.kind} @ block ${resolution.blockNumber}`;
    case "dead":
      return "dead";
    case "unknown":
      return `unknown: ${resolution.reason}`;
  }
}

const chain = createChainProof({ rpcUrl, pathUsd: PATH_USD, recipient, amount });

const report = [];
for (const row of rows) {
  const attempt: Attempt = {
    txHash: row.tx_hash as Hex,
    payer: row.payer as Address,
    validBefore: row.valid_before,
    createdBlock: BigInt(row.created_block),
  };
  const chainResult = describe(await chain.resolveAttempt(attempt));
  report.push({
    status: row.status,
    tap_id: row.tap_id,
    tx_hash: row.tx_hash,
    payer: row.payer,
    valid_before: new Date(row.valid_before * 1000).toISOString(),
    chain: chainResult,
    note: row.note ?? "",
  });
}

console.table(report);
