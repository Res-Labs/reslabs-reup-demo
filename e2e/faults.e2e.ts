import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { MODERATO_CHAIN_ID } from "@reup/chain-proof";
import Database from "better-sqlite3";
import { Mppx, tempo } from "mppx/client";
import { formatUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startFaultProxy } from "../scripts/fault-proxy";
import {
  chain,
  EXPLORER_TX,
  loadKeys,
  MODERATO_RPC,
  pathUsdBalance,
  startStack,
  toolField,
  waitFor,
} from "./harness";

const PRICE = 1_000_000n;

interface AttemptRow {
  tx_hash: Hex;
  status: "pending" | "paid" | "dead" | "review";
  valid_before: number;
  created_block: string;
  resolved_at: number | null;
}

interface OrderRow {
  order_id: string;
  tx_hash: Hex;
  payer: string;
  amount: string;
}

interface Ledger {
  attempts: AttemptRow[];
  order: OrderRow | undefined;
}

interface Tap {
  tapId: string;
  verificationId: string;
  verifyBlock: bigint;
}

interface Reply {
  status: number;
  body: { error?: string; order_id?: string; already_ordered?: boolean };
}

interface Row {
  name: string;
  reply: string;
  status: string;
  order: string;
  delta: string;
  tx: string;
}

const agent = loadKeys().agents[3] ?? assert.fail(".e2e/keys.json has agents[3]");
const proxy = await startFaultProxy({ upstream: MODERATO_RPC });
const stack = await startStack({ rpcUrl: proxy.url }).catch(async (error: unknown) => {
  await proxy.stop();
  throw error;
});
const payer = Mppx.create({
  polyfill: false,
  maxPaymentRetries: 1,
  methods: [
    tempo({
      account: privateKeyToAccount(agent.pk),
      expectedChainId: MODERATO_CHAIN_ID,
      expectedRecipients: [stack.recipient],
    }),
  ],
});
let signed = 0;
payer.onCredentialCreated(() => {
  signed += 1;
});

function ledger(tapId: string): Ledger {
  const db = new Database(stack.dbPath, { readonly: true, fileMustExist: true });
  try {
    return {
      attempts: db
        .prepare<[string], AttemptRow>(
          `SELECT tx_hash, status, valid_before, created_block, resolved_at
           FROM payment_attempts WHERE tap_id = ? ORDER BY created_at, rowid`,
        )
        .all(tapId),
      order: db
        .prepare<[string], OrderRow>(
          "SELECT order_id, tx_hash, payer, amount FROM orders WHERE tap_id = ?",
        )
        .get(tapId),
    };
  } finally {
    db.close();
  }
}

/** Allows several 15 s reconciler passes, since concurrent suites share the RPC's rate limit. */
async function resolved(tapId: string): Promise<Ledger> {
  return waitFor(
    async () => {
      const state = ledger(tapId);
      const settled =
        state.attempts.length > 0 && state.attempts.every((a) => a.status !== "pending");
      return settled ? state : undefined;
    },
    120_000,
    `tap ${tapId} to have no pending attempt`,
  );
}

async function blockAtOrAfter(unixSeconds: number): Promise<bigint> {
  return waitFor(
    async () => {
      const block = await chain.getBlock();
      return block.timestamp >= BigInt(unixSeconds) ? block.number : undefined;
    },
    120_000,
    `a Moderato block at or after ${unixSeconds}`,
  );
}

async function recipientDelta(from: bigint, to: bigint): Promise<bigint> {
  const at = (block: bigint) =>
    waitFor(
      () => pathUsdBalance(stack.recipient, block),
      30_000,
      `recipient balance at block ${block}`,
    );
  return (await at(to)) - (await at(from));
}

async function freshTap(): Promise<Tap> {
  proxy.setMode("pass");
  const client = await stack.mcpClient(agent.pk);
  try {
    const { isError, text } = await client.callTool("reslabs_verify_tap", {
      link: await stack.mint(),
    });
    assert.equal(isError, false, `reslabs_verify_tap succeeded through the pass proxy:\n${text}`);
    const feeTx = toolField(text, "Verification fee transaction").slice(EXPLORER_TX.length) as Hex;
    const { blockNumber } = await chain.waitForTransactionReceipt({ hash: feeTx, timeout: 60_000 });
    return {
      tapId: toolField(text, "Tap"),
      verificationId: toolField(text, "verification_id"),
      verifyBlock: blockNumber,
    };
  } finally {
    await client.close();
  }
}

async function reorder(verificationId: string): Promise<Reply> {
  const response = await payer.fetch(`${stack.storeUrl}/api/reorder`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verification_id: verificationId }),
  });
  return { status: response.status, body: (await response.json()) as Reply["body"] };
}

function describe(reply: Reply): string {
  return `${reply.status} ${reply.body.error ?? reply.body.order_id}`;
}

async function assertPaid(attempt: AttemptRow, order: OrderRow | undefined): Promise<OrderRow> {
  assert.equal(attempt.status, "paid", `attempt ${attempt.tx_hash} ends paid`);
  assert.ok(order !== undefined, `paid attempt ${attempt.tx_hash} has an order`);
  assert.deepEqual(
    { tx: order.tx_hash, payer: order.payer.toLowerCase(), amount: order.amount },
    { tx: attempt.tx_hash, payer: agent.address.toLowerCase(), amount: PRICE.toString() },
    "the order is the paid attempt's 1.00 transfer from the agent",
  );
  const receipt = await chain.waitForTransactionReceipt({ hash: attempt.tx_hash, timeout: 60_000 });
  assert.equal(receipt.status, "success", `${attempt.tx_hash} succeeded on Moderato`);
  return order;
}

async function assertLaterReorderReturns(tap: Tap, order: OrderRow): Promise<void> {
  const signedBefore = signed;
  const again = await reorder(tap.verificationId);
  assert.deepEqual(
    [again.status, again.body.order_id, again.body.already_ordered],
    [200, order.order_id, true],
    "a later reorder for the tap returns the existing order with already_ordered",
  );
  assert.equal(signed, signedBefore, "the later reorder signed no credential");
}

/** Reads every block from created_block through one at or past validBefore; returns that block. */
async function assertNeverIncluded(attempt: AttemptRow): Promise<bigint> {
  const through = await blockAtOrAfter(attempt.valid_before);
  // One block at a time: the public RPC answers bursts with 429.
  for (let n = BigInt(attempt.created_block); n <= through; n++) {
    const block = await waitFor(() => chain.getBlock({ blockNumber: n }), 30_000, `block ${n}`);
    assert.ok(
      !block.transactions.includes(attempt.tx_hash),
      `block ${n} does not include ${attempt.tx_hash}`,
    );
  }
  return through;
}

/** SIGKILLs the store's process group: a crash, with no graceful shutdown or last reconciler pass. */
async function crashStore(): Promise<number> {
  const port = new URL(stack.storeUrl).port;
  const [pid] = execFileSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })
    .trim()
    .split("\n");
  assert.ok(pid, `a process listens on store port ${port}`);
  const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", pid], { encoding: "utf8" }).trim());
  process.kill(-pgid, "SIGKILL");
  await waitFor(
    async () => {
      try {
        process.kill(-pgid, 0);
        return undefined;
      } catch {
        return true;
      }
    },
    10_000,
    `store process group ${pgid} to exit`,
  );
  return Math.floor(Date.now() / 1000);
}

async function paidDespite(mode: "drop-after-forward" | "hang-after-forward"): Promise<Row[]> {
  const tap = await freshTap();
  const [sendsBefore, signedBefore] = [proxy.seenSendRaw, signed];
  proxy.setMode(mode);
  const reply = await reorder(tap.verificationId);
  proxy.setMode("pass");
  assert.ok(proxy.seenSendRaw > sendsBefore, `the store broadcast through the ${mode} proxy`);
  assert.equal(signed - signedBefore, 1, "the client signed one credential");

  const {
    attempts: [attempt, ...extra],
    order,
  } = await resolved(tap.tapId);
  assert.ok(attempt && extra.length === 0, "the tap has exactly one payment attempt");
  const paid = await assertPaid(attempt, order);
  assert.ok(
    (reply.status === 200 &&
      reply.body.order_id === paid.order_id &&
      reply.body.already_ordered === false) ||
      (reply.status === 503 && reply.body.error === "settlement_pending"),
    `the faulted reorder answers with its new order or settlement_pending: ${JSON.stringify(reply)}`,
  );
  await assertLaterReorderReturns(tap, paid);

  const delta = await recipientDelta(tap.verifyBlock, await blockAtOrAfter(attempt.valid_before));
  assert.equal(delta, PRICE, "exactly one 1.00 transfer reached the recipient");
  return [
    {
      name: mode,
      reply: describe(reply),
      status: attempt.status,
      order: paid.order_id,
      delta: formatUnits(delta, 6),
      tx: attempt.tx_hash,
    },
  ];
}

async function reviewOnStrippedLogs(): Promise<Row[]> {
  const tap = await freshTap();
  const signedBefore = signed;
  proxy.setMode("strip-receipt-logs");
  const reply = await reorder(tap.verificationId);
  proxy.setMode("pass");
  assert.deepEqual(
    [reply.status, reply.body.error],
    [409, "needs_review"],
    "the reorder whose receipt lost its logs answers 409 needs_review",
  );
  const {
    attempts: [attempt, ...extra],
    order,
  } = ledger(tap.tapId);
  assert.ok(attempt && extra.length === 0, "the tap has exactly one payment attempt");
  assert.equal(attempt.status, "review", "the attempt ends review");
  assert.equal(order, undefined, "the review attempt has no order row");
  const receipt = await chain.waitForTransactionReceipt({ hash: attempt.tx_hash, timeout: 60_000 });
  assert.equal(receipt.status, "success", "read past the proxy, the review transaction succeeded");

  const second = await reorder(tap.verificationId);
  assert.deepEqual(
    [second.status, second.body.error],
    [409, "needs_review"],
    "a second reorder for the tap answers 409 needs_review",
  );
  assert.equal(signed - signedBefore, 1, "the second reorder signed no credential");
  assert.equal(ledger(tap.tapId).attempts.length, 1, "the second reorder created no attempt");

  const delta = await recipientDelta(tap.verifyBlock, await blockAtOrAfter(attempt.valid_before));
  assert.equal(delta, PRICE, "only the review attempt's 1.00 reached the recipient");
  return [
    {
      name: "strip-receipt-logs",
      reply: `${describe(reply)}, then ${describe(second)}`,
      status: attempt.status,
      order: "-",
      delta: formatUnits(delta, 6),
      tx: attempt.tx_hash,
    },
  ];
}

async function deadThenPaid(): Promise<Row[]> {
  const tap = await freshTap();
  const [sendsBefore, signedBefore] = [proxy.seenSendRaw, signed];
  proxy.setMode("drop-before-forward");
  const inflight = reorder(tap.verificationId);
  await waitFor(
    async () =>
      proxy.seenSendRaw > sendsBefore && ledger(tap.tapId).attempts[0]?.status === "pending"
        ? true
        : undefined,
    30_000,
    "a pending attempt whose broadcast the proxy dropped",
  );
  const reply = await inflight;
  proxy.setMode("pass");
  assert.ok(
    (reply.status === 402 && reply.body.error === "payment_not_settled") ||
      (reply.status === 503 && reply.body.error === "settlement_pending"),
    `the dropped reorder answers payment_not_settled or settlement_pending: ${JSON.stringify(reply)}`,
  );
  assert.equal(signed - signedBefore, 1, "the client did not retry the dropped payment");

  const {
    attempts: [dead, ...extra],
  } = await resolved(tap.tapId);
  assert.ok(dead && extra.length === 0, "the tap has exactly one payment attempt");
  assert.equal(dead.status, "dead", "the never-broadcast attempt ends dead");
  assert.ok(
    dead.resolved_at !== null && dead.resolved_at >= dead.valid_before,
    `the attempt stayed pending until validBefore ${dead.valid_before} (resolved ${dead.resolved_at})`,
  );
  const deadEnd = await assertNeverIncluded(dead);
  const deadDelta = await recipientDelta(tap.verifyBlock, deadEnd);
  assert.equal(deadDelta, 0n, "the dead attempt moved nothing to the recipient");

  const retry = await reorder(tap.verificationId);
  const { attempts, order } = ledger(tap.tapId);
  const [, attempt, ...more] = attempts;
  assert.ok(attempt && more.length === 0, "the new reorder made exactly one more attempt");
  const paid = await assertPaid(attempt, order);
  assert.deepEqual(
    [retry.status, retry.body.order_id, retry.body.already_ordered],
    [200, paid.order_id, false],
    "the new reorder after dead pays and places the order",
  );
  assert.equal(signed - signedBefore, 2, "the new reorder signed one credential");
  await assertLaterReorderReturns(tap, paid);

  const delta = await recipientDelta(deadEnd, await blockAtOrAfter(attempt.valid_before));
  assert.equal(delta, PRICE, "the new attempt paid exactly once");
  return [
    {
      name: "drop-before-forward",
      reply: describe(reply),
      status: dead.status,
      order: "-",
      delta: formatUnits(deadDelta, 6),
      tx: dead.tx_hash,
    },
    {
      name: "drop-before-forward, new reorder via pass",
      reply: describe(retry),
      status: attempt.status,
      order: paid.order_id,
      delta: formatUnits(delta, 6),
      tx: attempt.tx_hash,
    },
  ];
}

async function resolvedOnBoot(): Promise<Row[]> {
  const tap = await freshTap();
  const [sendsBefore, signedBefore] = [proxy.seenSendRaw, signed];
  proxy.setMode("hang-after-forward");
  const inflight = reorder(tap.verificationId).then(describe, (error: unknown) => {
    return `no answer (${error instanceof Error ? error.message : String(error)})`;
  });
  await waitFor(
    async () =>
      proxy.seenSendRaw > sendsBefore && ledger(tap.tapId).attempts[0]?.status === "pending"
        ? true
        : undefined,
    60_000,
    "a pending attempt whose transaction reached the hanging proxy",
  );
  const crashedAt = await crashStore();
  assert.equal(
    ledger(tap.tapId).attempts[0]?.status,
    "pending",
    "the attempt is pending when the store dies",
  );
  const reply = await inflight;
  assert.ok(
    reply.startsWith("no answer"),
    `the crashed store never answered the reorder: ${reply}`,
  );
  proxy.setMode("pass");
  const sendsAtRestart = proxy.seenSendRaw;
  await stack.restartStore();

  const {
    attempts: [attempt, ...extra],
    order,
  } = await resolved(tap.tapId);
  assert.ok(attempt && extra.length === 0, "the tap has exactly one payment attempt");
  const paid = await assertPaid(attempt, order);
  assert.ok(
    attempt.resolved_at !== null && attempt.resolved_at >= crashedAt,
    `the restarted store resolved the attempt (crashed ${crashedAt}, resolved ${attempt.resolved_at})`,
  );
  assert.equal(proxy.seenSendRaw, sendsAtRestart, "the restarted store did not broadcast again");
  assert.equal(signed - signedBefore, 1, "the client never retried");
  await assertLaterReorderReturns(tap, paid);

  const delta = await recipientDelta(tap.verifyBlock, await blockAtOrAfter(attempt.valid_before));
  assert.equal(delta, PRICE, "exactly one 1.00 transfer reached the recipient");
  return [
    {
      name: "restart with a pending attempt",
      reply: `${reply}; resolved ${attempt.resolved_at - crashedAt} s after the crash`,
      status: attempt.status,
      order: paid.order_id,
      delta: formatUnits(delta, 6),
      tx: attempt.tx_hash,
    },
  ];
}

const cases: [string, () => Promise<Row[]>][] = [
  ["drop-after-forward", () => paidDespite("drop-after-forward")],
  ["hang-after-forward", () => paidDespite("hang-after-forward")],
  ["strip-receipt-logs", reviewOnStrippedLogs],
  ["drop-before-forward", deadThenPaid],
  ["restart with a pending attempt", resolvedOnBoot],
];

console.log(
  `run ${stack.runId}: store ${stack.storeUrl} via fault proxy ${proxy.url}, mock ${stack.mockUrl}, agent ${agent.address}, recipient ${stack.recipient}`,
);
const rows: Row[] = [];
const failures: string[] = [];
try {
  for (const [name, run] of cases) {
    try {
      rows.push(...(await run()));
      console.log(`${name} passed`);
    } catch (error) {
      failures.push(name);
      rows.push({ name, reply: "FAILED", status: "-", order: "-", delta: "-", tx: "-" });
      console.error(`${name} FAILED:`, error);
      proxy.setMode("pass");
      // Every credential signed so far has validBefore at most 30 s ahead, so nothing from the
      // failed case can land after this block and skew the next case's balance delta.
      await blockAtOrAfter(Math.floor(Date.now() / 1000) + 31);
    }
  }
} finally {
  await stack.stop();
  await proxy.stop();
}

console.log("\ncase | reply | final status | order | recipient delta (pathUSD) | tx");
for (const r of rows) console.log([r.name, r.reply, r.status, r.order, r.delta, r.tx].join(" | "));
console.log(`\nexplorer: ${EXPLORER_TX}<tx>`);
if (failures.length > 0) {
  console.error(`\nfailed: ${failures.join(", ")}`);
  process.exitCode = 1;
}
