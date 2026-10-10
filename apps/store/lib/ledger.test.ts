import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import {
  attemptState,
  findIssuedChallenge,
  findOrderByTap,
  findVerification,
  listOrders,
  listPendingAttempts,
  markResolved,
  openAttemptStatus,
  type PaymentAttempt,
  recordIssuedChallenge,
  recordVerification,
  reserveAttempt,
  settle,
} from "./ledger";

const adminUrl = process.env.TEST_DATABASE_URL ?? "";
const schema = `reup_ledger_${randomBytes(6).toString("hex")}`;

Object.assign(process.env, {
  MPP_SECRET_KEY: "synthetic-store-secret-of-at-least-32-bytes",
  MPP_RECIPIENT: "0x00000000000000000000000000000000000000a1",
  DEMO_BATCH_ID: "6f1d2c3b-4a59-4e68-9d7c-8b0a1f2e3d4c",
  DEMO_SKU: "RL-DEMO-1",
  DEMO_PRICE: "1.00",
  RESLABS_LINK_ORIGIN: "http://localhost:4010",
  RESLABS_SESSION_URL: "http://localhost:4010/v/p/session",
  TEMPO_RPC_URL: "http://localhost:8545",
});

const PAYER = "0x00000000000000000000000000000000000000c3";
const PRICE = 1_000_000n;

async function admin(sql: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function attempt(tapId: string, hashByte: string): PaymentAttempt {
  return {
    txHash: `0x${hashByte.repeat(32)}`,
    tapId,
    payer: PAYER,
    validBefore: 1_800_000_025,
    createdBlock: 100n,
  };
}

function issue(challengeId: string, tapId: string): Promise<void> {
  return recordIssuedChallenge({ challengeId, tapId, amount: "1000000", expires: 1_800_000_300 });
}

describe("ledger", { skip: adminUrl === "" && "TEST_DATABASE_URL is not set" }, () => {
  before(async () => {
    await admin(`CREATE SCHEMA ${schema}`);
    const url = new URL(adminUrl);
    url.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
  });
  after(() => admin(`DROP SCHEMA ${schema} CASCADE`));

  it("records a verification under a ver_ id", async () => {
    const verification = await recordVerification({
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
    assert.deepEqual(await findVerification(verification.verificationId), verification);
  });

  it("spends a challenge once and holds one live attempt per tap", async () => {
    await issue("challenge-a1", "tap-a");
    await issue("challenge-a2", "tap-a");
    assert.equal(await reserveAttempt(attempt("tap-a", "01"), "challenge-a1"), true);
    assert.equal(await reserveAttempt(attempt("tap-a", "02"), "challenge-a1"), false);
    assert.equal(await reserveAttempt(attempt("tap-a", "02"), "challenge-a2"), false);
    assert.equal((await findIssuedChallenge("challenge-a2"))?.usedAt, null);
    assert.equal(await openAttemptStatus("tap-a"), "pending");
    assert.deepEqual(await listPendingAttempts("tap-a"), [attempt("tap-a", "01")]);
  });

  it("settles into exactly one order, idempotently", async () => {
    const first = await settle(attempt("tap-a", "01"), PRICE);
    assert.ok(first.status === "paid");
    assert.deepEqual(await settle(attempt("tap-a", "01"), PRICE), first);
    assert.deepEqual(await findOrderByTap("tap-a"), first.order);
    assert.equal(await openAttemptStatus("tap-a"), undefined);
    assert.equal(await reserveAttempt(attempt("tap-a", "02"), "challenge-a2"), false);
    const [order] = await listOrders();
    assert.equal(order?.amount, "1.00");
    assert.equal(order?.productName, "Demo Compound 10 mg");
    assert.match(order?.orderId ?? "", /^ord_[a-z2-7]{26}$/);
  });

  it("never revives a dead attempt and frees the tap for a new one", async () => {
    await issue("challenge-b1", "tap-b");
    await issue("challenge-b2", "tap-b");
    assert.equal(await reserveAttempt(attempt("tap-b", "03"), "challenge-b1"), true);
    await markResolved(
      `0x${"03".repeat(32)}`,
      "dead",
      "no block up to validBefore includes the transaction",
    );
    await markResolved(`0x${"03".repeat(32)}`, "review", "late");
    assert.deepEqual(await settle(attempt("tap-b", "03"), PRICE), { status: "dead" });
    assert.deepEqual(await attemptState(`0x${"03".repeat(32)}`), { status: "dead" });
    assert.equal(await findOrderByTap("tap-b"), undefined);
    assert.equal(await reserveAttempt(attempt("tap-b", "04"), "challenge-b2"), true);
  });

  it("lets concurrent requests reserve a tap once and settle it into one order", async () => {
    await issue("challenge-c1", "tap-c");
    await issue("challenge-c2", "tap-c");
    const reserved = await Promise.all([
      reserveAttempt(attempt("tap-c", "05"), "challenge-c1"),
      reserveAttempt(attempt("tap-c", "06"), "challenge-c2"),
    ]);
    assert.equal(reserved.filter(Boolean).length, 1);
    const winner = attempt("tap-c", reserved[0] ? "05" : "06");
    const [first, second] = await Promise.all([settle(winner, PRICE), settle(winner, PRICE)]);
    assert.ok(first.status === "paid");
    assert.deepEqual(second, first);
  });
});
