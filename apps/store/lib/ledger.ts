import { randomBytes } from "node:crypto";
import type { Address, Attempt, Hex } from "@reup/chain-proof";
import { DatabaseError } from "pg";
import { formatUnits } from "viem";
import { PATH_USD_DECIMALS } from "./config";
import { type Query, query, transaction } from "./db";

export interface Verification {
  verificationId: string;
  tapId: string;
  batchId: string;
  batchCode: string;
  productName: string;
  vendorName: string;
  coaUrl: string;
  payer: Address;
  txHash: string;
  createdAt: number;
}

export interface IssuedChallenge {
  challengeId: string;
  tapId: string;
  /** Base units, as the challenge carries them. */
  amount: string;
  expires: number;
  usedAt: number | null;
}

export interface PaymentAttempt extends Attempt {
  tapId: string;
}

export type AttemptStatus = "pending" | "paid" | "dead" | "review";

export interface Order {
  orderId: string;
  tapId: string;
  txHash: Hex;
  amount: bigint;
  payer: Address;
  createdAt: number;
}

export type AttemptState =
  | { status: "paid"; order: Order }
  | { status: Exclude<AttemptStatus, "paid"> };

export interface OrderView {
  orderId: string;
  tapId: string;
  productName: string;
  amount: string;
  payer: string;
  txHash: string;
  createdAt: number;
}

// Row shapes as node-postgres returns them: BIGINT columns arrive as decimal strings.
interface VerificationRow {
  verification_id: string;
  tap_id: string;
  batch_id: string;
  batch_code: string;
  product_name: string;
  vendor_name: string;
  coa_url: string;
  payer: Address;
  tx_hash: string;
  created_at: string;
}

interface IssuedChallengeRow {
  challenge_id: string;
  tap_id: string;
  amount: string;
  expires: string;
  used_at: string | null;
}

interface AttemptRow {
  tx_hash: Hex;
  tap_id: string;
  payer: Address;
  valid_before: string;
  created_block: string;
}

interface OrderRow {
  order_id: string;
  tap_id: string;
  tx_hash: Hex;
  amount: string;
  payer: Address;
  created_at: string;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const UNIQUE_VIOLATION = "23505";

export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

/** `ver_` / `ord_` plus 16 random bytes in unpadded RFC 4648 base32 (26 characters). */
function newId(prefix: "ver" | "ord"): string {
  let id = `${prefix}_`;
  let buffer = 0;
  let bits = 0;
  for (const byte of randomBytes(16)) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      id += BASE32.charAt((buffer >>> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  return bits > 0 ? id + BASE32.charAt((buffer << (5 - bits)) & 31) : id;
}

/** Decimal pathUSD with at least two fraction digits: 1000000n → "1.00", 1000n → "0.001". */
export function formatAmount(units: bigint): string {
  const [whole = "0", fraction = ""] = formatUnits(units, PATH_USD_DECIMALS).split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

export async function recordVerification(
  input: Omit<Verification, "verificationId" | "createdAt">,
): Promise<Verification> {
  const verification: Verification = {
    ...input,
    verificationId: newId("ver"),
    createdAt: unixNow(),
  };
  await query(
    `INSERT INTO verifications
      (verification_id, tap_id, batch_id, batch_code, product_name, vendor_name, coa_url, payer, tx_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      verification.verificationId,
      verification.tapId,
      verification.batchId,
      verification.batchCode,
      verification.productName,
      verification.vendorName,
      verification.coaUrl,
      verification.payer,
      verification.txHash,
      verification.createdAt,
    ],
  );
  return verification;
}

export async function findVerification(verificationId: string): Promise<Verification | undefined> {
  const { rows } = await query<VerificationRow>(
    "SELECT * FROM verifications WHERE verification_id = $1",
    [verificationId],
  );
  const row = rows[0];
  return (
    row && {
      verificationId: row.verification_id,
      tapId: row.tap_id,
      batchId: row.batch_id,
      batchCode: row.batch_code,
      productName: row.product_name,
      vendorName: row.vendor_name,
      coaUrl: row.coa_url,
      payer: row.payer,
      txHash: row.tx_hash,
      createdAt: Number(row.created_at),
    }
  );
}

export async function recordIssuedChallenge(
  challenge: Omit<IssuedChallenge, "usedAt">,
): Promise<void> {
  await query(
    "INSERT INTO issued_challenges (challenge_id, tap_id, amount, expires) VALUES ($1, $2, $3, $4)",
    [challenge.challengeId, challenge.tapId, challenge.amount, challenge.expires],
  );
}

export async function findIssuedChallenge(
  challengeId: string,
): Promise<IssuedChallenge | undefined> {
  const { rows } = await query<IssuedChallengeRow>(
    "SELECT * FROM issued_challenges WHERE challenge_id = $1",
    [challengeId],
  );
  const row = rows[0];
  return (
    row && {
      challengeId: row.challenge_id,
      tapId: row.tap_id,
      amount: row.amount,
      expires: Number(row.expires),
      usedAt: row.used_at === null ? null : Number(row.used_at),
    }
  );
}

export async function attemptExists(txHash: Hex): Promise<boolean> {
  const { rowCount } = await query("SELECT 1 FROM payment_attempts WHERE tx_hash = $1", [txHash]);
  return rowCount === 1;
}

/** A paid attempt is answered through its order, which `settle` writes in the same transaction. */
export async function openAttemptStatus(tapId: string): Promise<"pending" | "review" | undefined> {
  const { rows } = await query<{ status: "pending" | "review" }>(
    "SELECT status FROM payment_attempts WHERE tap_id = $1 AND status IN ('pending', 'review')",
    [tapId],
  );
  return rows[0]?.status;
}

/**
 * Marks the challenge used and inserts the pending attempt in one transaction.
 * Returns false when a concurrent request already used the challenge, reserved this hash,
 * or holds the tap's live attempt.
 */
export async function reserveAttempt(
  attempt: PaymentAttempt,
  challengeId: string,
): Promise<boolean> {
  const now = unixNow();
  try {
    return await transaction(async (tx) => {
      const used = await tx(
        "UPDATE issued_challenges SET used_at = $1 WHERE challenge_id = $2 AND used_at IS NULL",
        [now, challengeId],
      );
      // Nothing was written yet, so committing here leaves the ledger as a rollback would.
      if (used.rowCount !== 1) return false;
      await tx(
        `INSERT INTO payment_attempts (tx_hash, tap_id, payer, valid_before, status, created_block, created_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
        [
          attempt.txHash,
          attempt.tapId,
          attempt.payer,
          attempt.validBefore,
          attempt.createdBlock.toString(),
          now,
        ],
      );
      return true;
    });
  } catch (error) {
    if (error instanceof DatabaseError && error.code === UNIQUE_VIOLATION) return false;
    throw error;
  }
}

/** Every pending attempt, or only the tap's when `tapId` is given. */
export async function listPendingAttempts(tapId?: string): Promise<PaymentAttempt[]> {
  const { rows } = await query<AttemptRow>(
    `SELECT tx_hash, tap_id, payer, valid_before, created_block FROM payment_attempts
     WHERE status = 'pending' AND ($1::text IS NULL OR tap_id = $1)`,
    [tapId ?? null],
  );
  return rows.map((row) => ({
    txHash: row.tx_hash,
    tapId: row.tap_id,
    payer: row.payer,
    validBefore: Number(row.valid_before),
    createdBlock: BigInt(row.created_block),
  }));
}

/** Status changes only ever leave `pending`; a row that already left it is not touched. */
export async function markResolved(
  txHash: Hex,
  status: "dead" | "review",
  note: string,
): Promise<void> {
  await query(
    "UPDATE payment_attempts SET status = $1, resolved_at = $2, note = $3 WHERE tx_hash = $4 AND status = 'pending'",
    [status, unixNow(), note, txHash],
  );
}

async function findOrder(
  column: "tap_id" | "tx_hash",
  value: string,
  run: Query = query,
): Promise<Order | undefined> {
  const { rows } = await run<OrderRow>(`SELECT * FROM orders WHERE ${column} = $1`, [value]);
  const row = rows[0];
  return (
    row && {
      orderId: row.order_id,
      tapId: row.tap_id,
      txHash: row.tx_hash,
      amount: BigInt(row.amount),
      payer: row.payer,
      createdAt: Number(row.created_at),
    }
  );
}

export function findOrderByTap(tapId: string): Promise<Order | undefined> {
  return findOrder("tap_id", tapId);
}

export async function attemptState(txHash: Hex, run: Query = query): Promise<AttemptState> {
  const { rows } = await run<{ status: AttemptStatus }>(
    "SELECT status FROM payment_attempts WHERE tx_hash = $1",
    [txHash],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`No payment attempt ${txHash}`);
  if (row.status !== "paid") return { status: row.status };
  const order = await findOrder("tx_hash", txHash, run);
  if (order === undefined) throw new Error(`Paid attempt ${txHash} has no order`);
  return { status: "paid", order };
}

/**
 * Moves a pending attempt to `paid` and inserts its order in one transaction. Idempotent: only
 * the caller whose conditional UPDATE leaves `pending` inserts the order, and every later or
 * concurrent caller gets that order back. A `dead` or `review` row is never revived; finding its
 * transfer only adds a note for manual review. Such a row never changes status again, so the
 * note cannot land on a row that became `paid` meanwhile.
 */
export async function settle(attempt: PaymentAttempt, amount: bigint): Promise<AttemptState> {
  return transaction(async (tx): Promise<AttemptState> => {
    const now = unixNow();
    const paid = await tx(
      "UPDATE payment_attempts SET status = 'paid', resolved_at = $1 WHERE tx_hash = $2 AND status = 'pending'",
      [now, attempt.txHash],
    );
    if (paid.rowCount === 1) {
      const order: Order = {
        orderId: newId("ord"),
        tapId: attempt.tapId,
        txHash: attempt.txHash,
        amount,
        payer: attempt.payer,
        createdAt: now,
      };
      await tx(
        "INSERT INTO orders (order_id, tap_id, tx_hash, amount, payer, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [order.orderId, order.tapId, order.txHash, amount.toString(), order.payer, now],
      );
      return { status: "paid", order };
    }
    const state = await attemptState(attempt.txHash, tx);
    if (state.status !== "paid") {
      await tx(
        `UPDATE payment_attempts
         SET note = ltrim(coalesce(note, '') || ' | transfer found on chain after the attempt was ' || status, ' |')
         WHERE tx_hash = $1`,
        [attempt.txHash],
      );
    }
    return state;
  });
}

export async function listOrders(): Promise<OrderView[]> {
  const { rows } = await query<OrderRow & { product_name: string }>(
    `SELECT o.*,
            coalesce((SELECT v.product_name FROM verifications v WHERE v.tap_id = o.tap_id
                      ORDER BY v.created_at LIMIT 1), '') AS product_name
     FROM orders o ORDER BY o.created_at DESC, o.order_id DESC`,
  );
  return rows.map((row) => ({
    orderId: row.order_id,
    tapId: row.tap_id,
    productName: row.product_name,
    amount: formatAmount(BigInt(row.amount)),
    payer: row.payer,
    txHash: row.tx_hash,
    createdAt: Number(row.created_at),
  }));
}
