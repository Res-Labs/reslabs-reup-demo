import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  attemptState,
  findIssuedChallenge,
  findOrderByTap,
  findVerification,
  listOrders,
  markResolved,
  openAttemptStatus,
  type PaymentAttempt,
  recordIssuedChallenge,
  recordVerification,
  reserveAttempt,
  settle,
} from "./ledger";

const dir = mkdtempSync(path.join(tmpdir(), "reup-ledger-"));
after(() => rmSync(dir, { recursive: true, force: true }));

Object.assign(process.env, {
  MPP_SECRET_KEY: "synthetic-store-secret-of-at-least-32-bytes",
  MPP_RECIPIENT: "0x00000000000000000000000000000000000000a1",
  DEMO_BATCH_ID: "6f1d2c3b-4a59-4e68-9d7c-8b0a1f2e3d4c",
  DEMO_SKU: "RL-DEMO-1",
  DEMO_PRICE: "1.00",
  RESLABS_LINK_ORIGIN: "http://localhost:4010",
  RESLABS_SESSION_URL: "http://localhost:4010/v/p/session",
  TEMPO_RPC_URL: "http://localhost:8545",
  STORE_DB_PATH: path.join(dir, "store.db"),
});

const PAYER = "0x00000000000000000000000000000000000000c3";
const PRICE = 1_000_000n;

function attempt(tapId: string, hashByte: string): PaymentAttempt {
  return {
    txHash: `0x${hashByte.repeat(32)}`,
    tapId,
    payer: PAYER,
    validBefore: 1_800_000_025,
    createdBlock: 100n,
  };
}

function issue(challengeId: string, tapId: string): void {
  recordIssuedChallenge({ challengeId, tapId, amount: "1000000", expires: 1_800_000_300 });
}

describe("ledger", () => {
  it("records a verification under a ver_ id", () => {
    const verification = recordVerification({
      tapId: "tap-a",
      batchId: "6f1d2c3b-4a59-4e68-9d7c-8b0a1f2e3d4c",
      batchCode: "DEMO-0001",
      productName: "Demo Compound 10 mg",
      vendorName: "Demo Vendor",
      coaUrl: "",
      payer: PAYER,
      txHash: `0x${"0f".repeat(32)}`,
    });
    assert.match(verification.verificationId, /^ver_[a-z2-7]{26}$/);
    assert.deepEqual(findVerification(verification.verificationId), verification);
  });

  it("spends a challenge once and holds one live attempt per tap", () => {
    issue("challenge-a1", "tap-a");
    issue("challenge-a2", "tap-a");
    assert.equal(reserveAttempt(attempt("tap-a", "01"), "challenge-a1"), true);
    assert.equal(reserveAttempt(attempt("tap-a", "02"), "challenge-a1"), false);
    assert.equal(reserveAttempt(attempt("tap-a", "02"), "challenge-a2"), false);
    assert.equal(findIssuedChallenge("challenge-a2")?.usedAt, null);
    assert.equal(openAttemptStatus("tap-a"), "pending");
  });

  it("settles into exactly one order, idempotently", () => {
    const first = settle(attempt("tap-a", "01"), PRICE);
    assert.ok(first.status === "paid");
    assert.deepEqual(settle(attempt("tap-a", "01"), PRICE), first);
    assert.deepEqual(findOrderByTap("tap-a"), first.order);
    assert.equal(openAttemptStatus("tap-a"), undefined);
    assert.equal(reserveAttempt(attempt("tap-a", "02"), "challenge-a2"), false);
    const [order] = listOrders();
    assert.equal(order?.amount, "1.00");
    assert.equal(order?.productName, "Demo Compound 10 mg");
    assert.match(order?.orderId ?? "", /^ord_[a-z2-7]{26}$/);
  });

  it("never revives a dead attempt and frees the tap for a new one", () => {
    issue("challenge-b1", "tap-b");
    issue("challenge-b2", "tap-b");
    assert.equal(reserveAttempt(attempt("tap-b", "03"), "challenge-b1"), true);
    markResolved(
      `0x${"03".repeat(32)}`,
      "dead",
      "no block up to validBefore includes the transaction",
    );
    markResolved(`0x${"03".repeat(32)}`, "review", "late");
    assert.deepEqual(settle(attempt("tap-b", "03"), PRICE), { status: "dead" });
    assert.deepEqual(attemptState(`0x${"03".repeat(32)}`), { status: "dead" });
    assert.equal(findOrderByTap("tap-b"), undefined);
    assert.equal(reserveAttempt(attempt("tap-b", "04"), "challenge-b2"), true);
  });
});
