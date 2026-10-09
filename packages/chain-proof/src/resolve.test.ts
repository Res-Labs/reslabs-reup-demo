import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { numberToHex, pad } from "viem";
import { type Address, type Attempt, createChainProof, type Hex, PATH_USD } from "./index";
import { type Block, classifyBlocks, classifyReceipt, type Log, type Receipt } from "./resolve";

const TRANSFER_WITH_MEMO_TOPIC =
  "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PAYER: Address = "0x1111111111111111111111111111111111111111";
const RECIPIENT: Address = "0x2222222222222222222222222222222222222222";
const STRANGER: Address = "0x3333333333333333333333333333333333333333";
const OTHER_TOKEN: Address = "0x20c0000000000000000000000000000000000001";
const TX: Hex = `0x${"ab".repeat(32)}`;
const OTHER_TX: Hex = `0x${"cd".repeat(32)}`;
const MEMO: Hex = `0x${"ef".repeat(32)}`;
const PRICE = 1_000_000n;
const VALID_BEFORE = 1_760_000_030;

const attempt: Attempt = {
  txHash: TX,
  payer: PAYER,
  validBefore: VALID_BEFORE,
  createdBlock: 100n,
};
const payment = { pathUsd: PATH_USD, recipient: RECIPIENT, amount: PRICE };
const finalized: Block = { number: 200n, timestamp: VALID_BEFORE + 60, transactions: [] };

interface Transfer {
  topic0: Hex;
  token: Address;
  from: Address;
  to: Address;
  amount: bigint;
}

const PAYMENT_TRANSFER: Transfer = {
  topic0: TRANSFER_WITH_MEMO_TOPIC,
  token: PATH_USD,
  from: PAYER,
  to: RECIPIENT,
  amount: PRICE,
};

function transferLog(overrides: Partial<Transfer> = {}): Log {
  const { topic0, token, from, to, amount } = { ...PAYMENT_TRANSFER, ...overrides };
  return {
    address: token,
    topics: [topic0, pad(from), pad(to), MEMO],
    data: numberToHex(amount, { size: 32 }),
  };
}

function block(number: bigint, timestamp: number, transactions: Hex[] = [OTHER_TX]): Block {
  return { number, timestamp, transactions };
}

describe("classifyReceipt", () => {
  it("settles paid when a successful receipt logs the exact TransferWithMemo", () => {
    const receipt: Receipt = {
      blockNumber: 150n,
      status: "success",
      logs: [transferLog({ topic0: TRANSFER_TOPIC }), transferLog()],
    };
    assert.deepEqual(classifyReceipt(attempt, payment, finalized, receipt), {
      kind: "settled-paid",
      blockNumber: 150n,
    });
  });

  it("settles paid when the receipt sits exactly at the finalized block", () => {
    const receipt: Receipt = { blockNumber: 200n, status: "success", logs: [transferLog()] };
    assert.deepEqual(classifyReceipt(attempt, payment, finalized, receipt), {
      kind: "settled-paid",
      blockNumber: 200n,
    });
  });

  it("settles with no transfer when a successful receipt has no logs", () => {
    const receipt: Receipt = { blockNumber: 150n, status: "success", logs: [] };
    assert.deepEqual(classifyReceipt(attempt, payment, finalized, receipt), {
      kind: "settled-no-transfer",
      blockNumber: 150n,
    });
  });

  const mismatches: [string, Log][] = [
    ["a different amount", transferLog({ amount: 999_999n })],
    ["a different recipient", transferLog({ to: STRANGER })],
    ["a different payer", transferLog({ from: STRANGER })],
    ["a different token contract", transferLog({ token: OTHER_TOKEN })],
    ["a plain Transfer topic", transferLog({ topic0: TRANSFER_TOPIC })],
  ];
  for (const [name, log] of mismatches) {
    it(`settles with no transfer when the only transfer log has ${name}`, () => {
      const receipt: Receipt = { blockNumber: 150n, status: "success", logs: [log] };
      assert.deepEqual(classifyReceipt(attempt, payment, finalized, receipt), {
        kind: "settled-no-transfer",
        blockNumber: 150n,
      });
    });
  }

  it("treats a reverted receipt that still logged the payment as no-transfer", () => {
    const receipt: Receipt = { blockNumber: 150n, status: "reverted", logs: [transferLog()] };
    assert.deepEqual(classifyReceipt(attempt, payment, finalized, receipt), {
      kind: "settled-no-transfer",
      blockNumber: 150n,
    });
  });

  it("marks a reverted receipt without the payment log as reverted-no-transfer", () => {
    const receipt: Receipt = {
      blockNumber: 150n,
      status: "reverted",
      logs: [transferLog({ to: STRANGER })],
    };
    assert.deepEqual(classifyReceipt(attempt, payment, finalized, receipt), {
      kind: "reverted-no-transfer",
      blockNumber: 150n,
    });
  });

  it("returns unknown for a receipt above the finalized block", () => {
    const receipt: Receipt = { blockNumber: 201n, status: "success", logs: [transferLog()] };
    assert.deepEqual(classifyReceipt(attempt, payment, finalized, receipt), {
      kind: "unknown",
      reason: "receipt block 201 is above finalized block 200",
    });
  });

  it("returns unknown without a receipt while finalized time is before validBefore", () => {
    const early: Block = { number: 200n, timestamp: VALID_BEFORE - 1, transactions: [] };
    assert.deepEqual(classifyReceipt(attempt, payment, early, null), {
      kind: "unknown",
      reason: "no receipt and finalized block 200 is before validBefore",
    });
  });

  it("scans from the created block once finalized time reaches validBefore", () => {
    const atExpiry: Block = { number: 200n, timestamp: VALID_BEFORE, transactions: [] };
    assert.deepEqual(classifyReceipt(attempt, payment, atExpiry, null), {
      kind: "scan-blocks",
      from: 100n,
      through: 200n,
    });
  });

  it("returns unknown when the RPC has no finalized block", () => {
    assert.deepEqual(classifyReceipt(attempt, payment, null, null), {
      kind: "unknown",
      reason: "RPC returned no finalized block",
    });
  });
});

describe("classifyBlocks", () => {
  it("proves dead when no block up to validBefore holds the transaction", () => {
    const blocks = [
      block(100n, VALID_BEFORE - 30),
      block(101n, VALID_BEFORE - 20),
      block(102n, VALID_BEFORE - 10),
      block(103n, VALID_BEFORE),
    ];
    assert.deepEqual(classifyBlocks(attempt, 100n, blocks), { kind: "dead" });
  });

  it("keeps scanning while no block has reached validBefore", () => {
    const blocks = [block(100n, VALID_BEFORE - 30), block(101n, VALID_BEFORE - 1)];
    assert.deepEqual(classifyBlocks(attempt, 100n, blocks), { kind: "keep-scanning" });
  });

  it("returns unknown for a null block inside the range", () => {
    const blocks = [block(100n, VALID_BEFORE - 30), null, block(102n, VALID_BEFORE)];
    assert.deepEqual(classifyBlocks(attempt, 100n, blocks), {
      kind: "unknown",
      reason: "RPC returned null for block 101",
    });
  });

  it("returns unknown when a block contains the transaction", () => {
    const blocks = [
      block(100n, VALID_BEFORE - 30),
      block(101n, VALID_BEFORE - 20, [OTHER_TX, TX]),
      block(102n, VALID_BEFORE),
    ];
    assert.deepEqual(classifyBlocks(attempt, 100n, blocks), {
      kind: "unknown",
      reason: "transaction is in block 101 but has no receipt",
    });
  });

  it("stops at the first block whose timestamp reaches validBefore", () => {
    const blocks = [
      block(100n, VALID_BEFORE - 1),
      block(101n, VALID_BEFORE),
      null,
      block(103n, VALID_BEFORE + 1, [TX]),
    ];
    assert.deepEqual(classifyBlocks(attempt, 100n, blocks), { kind: "dead" });
  });
});

interface RpcBlock {
  number: Hex;
  timestamp: Hex;
  transactions: Hex[];
}

interface RpcRequest {
  id: number;
  method: string;
  params: unknown[];
}

type Reply = { result: unknown } | { error: { code: number; message: string } };

function rpcBlock(number: bigint, timestamp: number): RpcBlock {
  return {
    number: numberToHex(number),
    timestamp: numberToHex(timestamp),
    transactions: [OTHER_TX],
  };
}

function rpcServer(reply: (method: string, params: unknown[]) => Reply): typeof fetch {
  return async (_input, init) => {
    const requests = JSON.parse(String(init?.body)) as RpcRequest[];
    const replies = requests.map(({ id, method, params }) => ({
      jsonrpc: "2.0",
      id,
      ...reply(method, params),
    }));
    // JSON-RPC lets a server answer a batch in any order.
    return Response.json(replies.reverse());
  };
}

function chain(head: RpcBlock, receipt: unknown, blocks: RpcBlock[] = []): typeof fetch {
  return rpcServer((method, [tag]) => {
    if (method === "eth_getTransactionReceipt") return { result: receipt };
    if (tag === "finalized") return { result: head };
    return { result: blocks.find((candidate) => candidate.number === tag) ?? null };
  });
}

function proofOver(fetchFn: typeof fetch) {
  return createChainProof({
    rpcUrl: "http://localhost:8545",
    pathUsd: PATH_USD,
    recipient: RECIPIENT,
    amount: PRICE,
    fetch: fetchFn,
  });
}

describe("createChainProof", () => {
  it("reads the finalized block number", async () => {
    const proof = proofOver(chain(rpcBlock(200n, VALID_BEFORE + 60), null));
    assert.equal(await proof.finalizedBlockNumber(), 200n);
  });

  it("proves payment from hex-encoded RPC data", async () => {
    const receipt = {
      blockNumber: "0x96",
      status: "0x1",
      logs: [{ ...transferLog(), logIndex: "0x0", removed: false }],
    };
    const proof = proofOver(chain(rpcBlock(200n, VALID_BEFORE + 60), receipt));
    assert.deepEqual(await proof.resolveAttempt(attempt), {
      kind: "settled-paid",
      blockNumber: 150n,
    });
  });

  it("proves dead across batches, ignoring blocks past validBefore", async () => {
    const blocks: RpcBlock[] = [];
    for (let n = 100; n <= 230; n++) blocks.push(rpcBlock(BigInt(n), VALID_BEFORE - 230 + n));
    const proof = proofOver(chain(rpcBlock(260n, VALID_BEFORE + 30), null, blocks));
    assert.deepEqual(await proof.resolveAttempt(attempt), { kind: "dead" });
  });

  it("returns unknown when the RPC answers with an error", async () => {
    const proof = proofOver(
      rpcServer((method) =>
        method === "eth_getTransactionReceipt"
          ? { error: { code: -32005, message: "rate limited" } }
          : { result: rpcBlock(200n, VALID_BEFORE + 60) },
      ),
    );
    assert.deepEqual(await proof.resolveAttempt(attempt), {
      kind: "unknown",
      reason: 'RPC error: {"code":-32005,"message":"rate limited"}',
    });
  });

  it("returns unknown when the RPC endpoint fails", async () => {
    const proof = proofOver(async () => new Response("unavailable", { status: 503 }));
    assert.deepEqual(await proof.resolveAttempt(attempt), {
      kind: "unknown",
      reason: "RPC HTTP 503",
    });
  });
});
