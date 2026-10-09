import { randomBytes } from "node:crypto";
import type { Address, Attempt, Hex } from "@reup/chain-proof";
import Database from "better-sqlite3";
import { formatUnits } from "viem";
import { PATH_USD_DECIMALS } from "./config";
import { db } from "./db";

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

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

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

export function recordVerification(
  input: Omit<Verification, "verificationId" | "createdAt">,
): Verification {
  const verification: Verification = {
    ...input,
    verificationId: newId("ver"),
    createdAt: unixNow(),
  };
  db()
    .prepare(
      `INSERT INTO verifications
        (verification_id, tap_id, batch_id, batch_code, product_name, vendor_name, coa_url, payer, tx_hash, created_at)
       VALUES
        (@verificationId, @tapId, @batchId, @batchCode, @productName, @vendorName, @coaUrl, @payer, @txHash, @createdAt)`,
    )
    .run(verification);
  return verification;
}

export function findVerification(verificationId: string): Verification | undefined {
  return db()
    .prepare<[string], Verification>(
      `SELECT verification_id AS verificationId, tap_id AS tapId, batch_id AS batchId, batch_code AS batchCode,
              product_name AS productName, vendor_name AS vendorName, coa_url AS coaUrl, payer,
              tx_hash AS txHash, created_at AS createdAt
       FROM verifications WHERE verification_id = ?`,
    )
    .get(verificationId);
}

export function recordIssuedChallenge(challenge: Omit<IssuedChallenge, "usedAt">): void {
  db()
    .prepare(
      "INSERT INTO issued_challenges (challenge_id, tap_id, amount, expires) VALUES (?, ?, ?, ?)",
    )
    .run(challenge.challengeId, challenge.tapId, challenge.amount, challenge.expires);
}

export function findIssuedChallenge(challengeId: string): IssuedChallenge | undefined {
  return db()
    .prepare<[string], IssuedChallenge>(
      `SELECT challenge_id AS challengeId, tap_id AS tapId, amount, expires, used_at AS usedAt
       FROM issued_challenges WHERE challenge_id = ?`,
    )
    .get(challengeId);
}

export function attemptExists(txHash: Hex): boolean {
  return db().prepare("SELECT 1 FROM payment_attempts WHERE tx_hash = ?").get(txHash) !== undefined;
}

/** A paid attempt is answered through its order, which `settle` writes in the same transaction. */
export function openAttemptStatus(tapId: string): "pending" | "review" | undefined {
  return db()
    .prepare<[string], { status: "pending" | "review" }>(
      "SELECT status FROM payment_attempts WHERE tap_id = ? AND status IN ('pending', 'review')",
    )
    .get(tapId)?.status;
}

/**
 * Marks the challenge used and inserts the pending attempt in one transaction.
 * Returns false when a concurrent request already used the challenge, reserved this hash,
 * or holds the tap's live attempt.
 */
export function reserveAttempt(attempt: PaymentAttempt, challengeId: string): boolean {
  const now = unixNow();
  const reserve = db().transaction((): boolean => {
    const used = db()
      .prepare(
        "UPDATE issued_challenges SET used_at = ? WHERE challenge_id = ? AND used_at IS NULL",
      )
      .run(now, challengeId);
    if (used.changes !== 1) return false;
    db()
      .prepare(
        `INSERT INTO payment_attempts (tx_hash, tap_id, payer, valid_before, status, created_block, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        attempt.txHash,
        attempt.tapId,
        attempt.payer,
        attempt.validBefore,
        attempt.createdBlock.toString(),
        now,
      );
    return true;
  });
  try {
    return reserve();
  } catch (error) {
    if (error instanceof Database.SqliteError && error.code.startsWith("SQLITE_CONSTRAINT"))
      return false;
    throw error;
  }
}

export function listPendingAttempts(): PaymentAttempt[] {
  return db()
    .prepare<[], Omit<PaymentAttempt, "createdBlock"> & { createdBlock: string }>(
      `SELECT tx_hash AS txHash, tap_id AS tapId, payer, valid_before AS validBefore, created_block AS createdBlock
       FROM payment_attempts WHERE status = 'pending'`,
    )
    .all()
    .map((row) => ({ ...row, createdBlock: BigInt(row.createdBlock) }));
}

/** Status changes only ever leave `pending`; a row that already left it is not touched. */
export function markResolved(txHash: Hex, status: "dead" | "review", note: string): void {
  db()
    .prepare(
      "UPDATE payment_attempts SET status = ?, resolved_at = ?, note = ? WHERE tx_hash = ? AND status = 'pending'",
    )
    .run(status, unixNow(), note, txHash);
}

function findOrder(column: "tap_id" | "tx_hash", value: string): Order | undefined {
  const row = db()
    .prepare<[string], Omit<Order, "amount"> & { amount: string }>(
      `SELECT order_id AS orderId, tap_id AS tapId, tx_hash AS txHash, amount, payer, created_at AS createdAt
       FROM orders WHERE ${column} = ?`,
    )
    .get(value);
  return row && { ...row, amount: BigInt(row.amount) };
}

export function findOrderByTap(tapId: string): Order | undefined {
  return findOrder("tap_id", tapId);
}

export function attemptState(txHash: Hex): AttemptState {
  const row = db()
    .prepare<[string], { status: AttemptStatus }>(
      "SELECT status FROM payment_attempts WHERE tx_hash = ?",
    )
    .get(txHash);
  if (row === undefined) throw new Error(`No payment attempt ${txHash}`);
  if (row.status !== "paid") return { status: row.status };
  const order = findOrder("tx_hash", txHash);
  if (order === undefined) throw new Error(`Paid attempt ${txHash} has no order`);
  return { status: "paid", order };
}

/**
 * Moves a pending attempt to `paid` and inserts its order in one transaction. Idempotent: an
 * existing order is returned unchanged. A `dead` or `review` row is never revived; finding its
 * transfer only adds a note for manual review.
 */
export function settle(attempt: PaymentAttempt, amount: bigint): AttemptState {
  return db().transaction((): AttemptState => {
    const existing = findOrder("tx_hash", attempt.txHash);
    if (existing !== undefined) return { status: "paid", order: existing };
    const now = unixNow();
    const paid = db()
      .prepare(
        "UPDATE payment_attempts SET status = 'paid', resolved_at = ? WHERE tx_hash = ? AND status = 'pending'",
      )
      .run(now, attempt.txHash);
    if (paid.changes === 1) {
      const order: Order = {
        orderId: newId("ord"),
        tapId: attempt.tapId,
        txHash: attempt.txHash,
        amount,
        payer: attempt.payer,
        createdAt: now,
      };
      db()
        .prepare(
          "INSERT INTO orders (order_id, tap_id, tx_hash, amount, payer, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(order.orderId, order.tapId, order.txHash, amount.toString(), order.payer, now);
      return { status: "paid", order };
    }
    db()
      .prepare(
        `UPDATE payment_attempts
         SET note = ltrim(coalesce(note, '') || ' | transfer found on chain after the attempt was ' || status, ' |')
         WHERE tx_hash = ?`,
      )
      .run(attempt.txHash);
    return attemptState(attempt.txHash);
  })();
}

export function listOrders(): OrderView[] {
  return db()
    .prepare<[], OrderView>(
      `SELECT o.order_id AS orderId, o.tap_id AS tapId, o.amount, o.payer, o.tx_hash AS txHash,
              o.created_at AS createdAt,
              coalesce((SELECT v.product_name FROM verifications v WHERE v.tap_id = o.tap_id
                        ORDER BY v.created_at LIMIT 1), '') AS productName
       FROM orders o ORDER BY o.created_at DESC, o.rowid DESC`,
    )
    .all()
    .map((row) => ({ ...row, amount: formatAmount(BigInt(row.amount)) }));
}
