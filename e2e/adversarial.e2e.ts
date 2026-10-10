import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createChainProof, MODERATO_CHAIN_ID, PATH_USD } from "@reup/chain-proof";
import { Challenge, Credential } from "mppx";
import { Proof } from "mppx/tempo";
import {
  type Address,
  concat,
  createClient,
  encodeFunctionData,
  type Hex,
  http,
  keccak256,
  padHex,
  slice,
  stringToBytes,
} from "viem";
import { getTransactionCount, prepareTransactionRequest } from "viem/actions";
import { tempoModerato } from "viem/chains";
import { Abis, Account } from "viem/tempo";
import { startFaultProxy } from "../scripts/fault-proxy";
import {
  chain,
  loadKeys,
  type McpClient,
  MODERATO_RPC,
  pathUsdBalance,
  REPO_ROOT,
  type Stack,
  startStack,
  toolField,
  waitFor,
} from "./harness";

interface Tap {
  link: string;
  verificationId: string;
}

interface Tweak {
  memoFor?: string;
  protocolNonce?: boolean;
  validBefore?: number;
}

interface Row {
  name: string;
  status: string;
  error: string;
  reason: string;
  attempts: string;
  sendRaw: string;
}

const keys = loadKeys();
const agent = keys.agents[2] ?? assert.fail(".e2e/keys.json has agents[2]");
const account = Account.fromSecp256k1(agent.pk);
const rpc = createClient({ chain: tempoModerato, transport: http(MODERATO_RPC) });
const unixNow = () => Math.floor(Date.now() / 1000);

const rows: Row[] = [];
const failures: string[] = [];

function check(name: string, ok: boolean, message: string): void {
  if (!ok) failures.push(`${name}: ${message}`);
}

/** mppx's attribution memo: tag, version, server fingerprint, anonymous client, challenge nonce. */
function attributionMemo(realm: string, challengeId: string): Hex {
  return concat([
    slice(keccak256(stringToBytes("mpp")), 0, 4),
    "0x01",
    slice(keccak256(stringToBytes(realm)), 0, 10),
    padHex("0x", { size: 10 }),
    slice(keccak256(stringToBytes(challengeId)), 0, 7),
  ]);
}

/** Signs the transfer mppx's tempo client would sign for `challenge`, changed only by `tweak`. */
async function signTransfer(
  challenge: Challenge.Challenge,
  recipient: Address,
  tweak: Tweak = {},
): Promise<Hex> {
  const call = {
    to: PATH_USD,
    data: encodeFunctionData({
      abi: Abis.tip20,
      functionName: "transferWithMemo",
      args: [
        recipient,
        BigInt(challenge.request.amount as string),
        attributionMemo(challenge.realm, tweak.memoFor ?? challenge.id),
      ],
    }),
  };
  const validBefore = unixNow() + 25;
  const nonce = tweak.protocolNonce
    ? { nonceKey: 0n, nonce: await getTransactionCount(rpc, { address: account.address }) }
    : { nonceKey: "expiring" as const };
  const prepared = await prepareTransactionRequest(rpc, {
    account,
    calls: [call],
    ...nonce,
    validBefore,
  });
  return account.signTransaction({
    chainId: MODERATO_CHAIN_ID,
    calls: [call],
    nonceKey: prepared.nonceKey,
    nonce: prepared.nonce,
    // Applied after estimation, so the signed bytes differ from the canonical transfer only here.
    validBefore: tweak.validBefore ?? prepared.validBefore,
    validAfter: prepared.validAfter,
    gas: (prepared.gas ?? 0n) + 5000n,
    maxFeePerGas: prepared.maxFeePerGas,
    maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
  });
}

function authorization(challenge: Challenge.Challenge, signature: Hex): string {
  return Credential.serialize({
    challenge,
    payload: { type: "transaction", signature },
    source: Proof.proofSource({ address: account.address, chainId: MODERATO_CHAIN_ID }),
  });
}

function postReorder(stack: Stack, verificationId: string, auth?: string): Promise<Response> {
  return fetch(`${stack.storeUrl}/api/reorder`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth === undefined ? {} : { authorization: auth }),
    },
    body: JSON.stringify({ verification_id: verificationId }),
  });
}

async function issueChallenge(stack: Stack, tap: Tap): Promise<Challenge.Challenge> {
  const response = await postReorder(stack, tap.verificationId);
  assert.equal(response.status, 402, "an unpaid reorder is answered with a challenge");
  return Challenge.fromResponse(response);
}

async function verifyTap(stack: Stack, client: McpClient): Promise<Tap> {
  const link = await stack.mint();
  const { isError, text } = await client.callTool("reslabs_verify_tap", { link });
  assert.equal(isError, false, `reslabs_verify_tap succeeded:\n${text}`);
  return { link, verificationId: toolField(text, "verification_id") };
}

function rejectionSince(stack: Stack, offset: number): string {
  const added = readFileSync(path.join(stack.runDir, "store.log")).subarray(offset).toString();
  return added.match(/credential rejected before broadcast \((\w+)\)/)?.[1] ?? "-";
}

async function counts(stack: Stack): Promise<{ attempts: number; orders: number }> {
  const [row] = await stack.query<{ attempts: string; orders: string }>(
    "SELECT (SELECT count(*) FROM payment_attempts) AS attempts, (SELECT count(*) FROM orders) AS orders",
  );
  return { attempts: Number(row?.attempts), orders: Number(row?.orders) };
}

/**
 * Sends one adversarial reorder and asserts the store refused it before broadcast: 400,
 * the expected binding failure in the store log, no attempt or order row, no
 * eth_sendRawTransaction* reaching the RPC proxy, and no change to the agent's balance.
 */
async function probe(
  ctx: { stack: Stack; seenSendRaw: () => number },
  name: string,
  verificationId: string,
  auth: string,
  expectedReason: string,
): Promise<void> {
  const before = {
    ...(await counts(ctx.stack)),
    sendRaw: ctx.seenSendRaw(),
    balance: await pathUsdBalance(agent.address),
    log: readFileSync(path.join(ctx.stack.runDir, "store.log")).length,
  };
  const response = await postReorder(ctx.stack, verificationId, auth);
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  const after = {
    ...(await counts(ctx.stack)),
    sendRaw: ctx.seenSendRaw(),
    balance: await pathUsdBalance(agent.address),
  };
  const reason = rejectionSince(ctx.stack, before.log);
  const attempts = after.attempts - before.attempts;
  const sendRaw = after.sendRaw - before.sendRaw;
  rows.push({
    name,
    status: String(response.status),
    error: body.error ?? "-",
    reason,
    attempts: String(attempts),
    sendRaw: String(sendRaw),
  });
  check(name, response.status === 400, `HTTP ${response.status}, expected 400`);
  check(name, body.error === "bad_credential", `error ${body.error}, expected bad_credential`);
  check(
    name,
    reason === expectedReason,
    `store rejected for ${reason}, expected ${expectedReason}`,
  );
  check(name, attempts === 0, `${attempts} new payment_attempts rows`);
  check(name, after.orders === before.orders, `${after.orders - before.orders} new orders`);
  check(name, sendRaw === 0, `${sendRaw} eth_sendRawTransaction* calls reached the RPC`);
  check(
    name,
    after.balance === before.balance,
    `agent balance moved by ${after.balance - before.balance}`,
  );
}

/** Forwards to the store and records every Authorization header sent to /api/reorder. */
async function startRecorder(upstream: string) {
  const reorderAuthorizations: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (req.url === "/api/reorder" && req.headers.authorization !== undefined) {
      reorderAuthorizations.push(req.headers.authorization);
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string" && key !== "host" && key !== "content-length")
        headers.set(key, value);
    }
    const upstreamRes = await fetch(`${upstream}${req.url}`, {
      method: req.method,
      headers,
      body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
    });
    res.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers));
    res.end(Buffer.from(await upstreamRes.arrayBuffer()));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    reorderAuthorizations,
    async stop() {
      server.close();
      await once(server, "close");
    },
  };
}

async function mcpVia(storeUrl: string, recipient: Address): Promise<McpClient> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO_ROOT, "apps/mcp/dist/index.js")],
    env: {
      PATH: process.env.PATH ?? "",
      AGENT_KEY: agent.pk,
      STORE_URL: storeUrl,
      MPP_RECIPIENT: recipient,
    },
    stderr: "ignore",
  });
  const raw = new Client({ name: "reup-e2e-adversarial", version: "0.0.0" });
  await raw.connect(transport);
  return {
    async callTool(name, args) {
      const result = await raw.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
      const content = result.content as { type: string; text?: string }[];
      return {
        isError: result.isError === true,
        text: content.map((c) => c.text ?? "").join("\n"),
      };
    },
    close: () => raw.close(),
  };
}

async function priceCapCase(stack: Stack): Promise<void> {
  const recorder = await startRecorder(stack.storeUrl);
  const client = await mcpVia(recorder.url, stack.recipient);
  try {
    const link = await stack.mint();
    const verified = await client.callTool("reslabs_verify_tap", { link });
    assert.equal(verified.isError, false, `verify on the 2.00 store succeeded:\n${verified.text}`);
    const verificationId = toolField(verified.text, "verification_id");
    const balanceBefore = await pathUsdBalance(agent.address);
    const { isError, text } = await client.callTool("reslabs_reorder", {
      verification_id: verificationId,
    });
    const balanceAfter = await pathUsdBalance(agent.address);
    const { attempts, orders } = await counts(stack);
    const [issued] = (
      await stack.query<{ n: string; used: string }>(
        "SELECT count(*) AS n, count(used_at) AS used FROM issued_challenges",
      )
    ).map((r) => ({ n: Number(r.n), used: Number(r.used) }));
    const name = "k: 2.00 store, MCP over 1.10 cap";
    rows.push({
      name,
      status: isError ? "refused" : "paid",
      error: text.split("\n")[0]?.slice(0, 60) ?? "-",
      reason: `auth seen ${recorder.reorderAuthorizations.length}`,
      attempts: String(attempts),
      sendRaw: "n/a",
    });
    check(name, isError, `reslabs_reorder did not refuse:\n${text}`);
    check(
      name,
      text.includes("exceeds the per-charge limit of 1100000") &&
        text.includes("Nothing was signed"),
      `refusal names the cap:\n${text}`,
    );
    check(
      name,
      balanceAfter === balanceBefore,
      `agent balance moved by ${balanceAfter - balanceBefore}`,
    );
    check(
      name,
      recorder.reorderAuthorizations.length === 0,
      `store received ${recorder.reorderAuthorizations.length} reorder Authorization headers`,
    );
    check(
      name,
      attempts === 0 && orders === 0,
      `${attempts} attempts, ${orders} orders on the 2.00 store`,
    );
    check(
      name,
      issued?.n === 1 && issued.used === 0,
      `issued challenges ${JSON.stringify(issued)}, expected 1 unused`,
    );
  } finally {
    await client.close();
    await recorder.stop();
  }
}

const proxy = await startFaultProxy({ upstream: MODERATO_RPC });
const [mainStack, capStack] = await Promise.allSettled([
  startStack({ rpcUrl: proxy.url }),
  startStack({ demoPrice: "2.00" }),
]);
const stacks = [mainStack, capStack].flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
try {
  if (mainStack.status === "rejected") throw mainStack.reason;
  if (capStack.status === "rejected") throw capStack.reason;
  const stack = mainStack.value;
  console.log(
    `run ${stack.runId}: store ${stack.storeUrl} via RPC proxy ${proxy.url}, recipient ${stack.recipient}`,
  );
  console.log(`price-cap run ${capStack.value.runId}: store ${capStack.value.storeUrl}`);

  const client = await stack.mcpClient(agent.pk);
  const taps: Record<string, Tap> = {};
  try {
    for (const name of ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "U"]) {
      taps[name] = await verifyTap(stack, client);
    }
  } finally {
    await client.close();
  }
  const tap = (name: string): Tap => {
    const t = taps[name];
    assert.ok(t !== undefined, `tap ${name} was verified`);
    return t;
  };
  const ctx = { stack, seenSendRaw: () => proxy.seenSendRaw };

  const expiring = await issueChallenge(stack, tap("E"));
  assert.ok(expiring.expires !== undefined, "store challenges carry expires");

  const challengeA = await issueChallenge(stack, tap("A"));
  const settledTx = await signTransfer(challengeA, stack.recipient);
  const authA = authorization(challengeA, settledTx);
  await probe(
    ctx,
    "a: tap A credential, tap B verification",
    tap("B").verificationId,
    authA,
    "challenge_not_issued",
  );

  const paid = await postReorder(stack, tap("A").verificationId, authA);
  const paidBody = (await paid.json()) as { tx_hash?: Hex; already_ordered?: boolean };
  assert.equal(paid.status, 200, `the same credential pays tap A: ${JSON.stringify(paidBody)}`);
  assert.equal(paidBody.already_ordered, false, "tap A gets a new order");
  assert.equal(paidBody.tx_hash, keccak256(settledTx), "tap A's order is the signed transfer");
  const receipt = await chain.waitForTransactionReceipt({
    hash: keccak256(settledTx),
    timeout: 60_000,
  });
  assert.equal(receipt.status, "success", "tap A's transfer settled on Moderato");
  console.log(`control: tap A paid by ${receipt.transactionHash} in block ${receipt.blockNumber}`);

  const challengeJ = await issueChallenge(stack, tap("J"));
  await probe(
    ctx,
    "j: settled tx, fresh challenge",
    tap("J").verificationId,
    authorization(challengeJ, settledTx),
    "memo_unbound",
  );
  await probe(
    ctx,
    "j: settled tx, its own used challenge",
    tap("J").verificationId,
    authA,
    "challenge_not_issued",
  );

  const challengeC = await issueChallenge(stack, tap("C"));
  const tamperedId = {
    ...challengeC,
    id: `${challengeC.id.slice(0, -2)}${challengeC.id.endsWith("AA") ? "BB" : "AA"}`,
  };
  await probe(
    ctx,
    "b: challenge id tampered",
    tap("C").verificationId,
    authorization(tamperedId, await signTransfer(tamperedId, stack.recipient)),
    "challenge_forged",
  );
  const extended = { ...challengeC, expires: new Date(Date.now() + 3_600_000).toISOString() };
  await probe(
    ctx,
    "b: issued challenge, expires rewritten",
    tap("C").verificationId,
    authorization(extended, await signTransfer(extended, stack.recipient)),
    "challenge_forged",
  );

  const challengeD = await issueChallenge(stack, tap("D"));
  const { id: _id, ...fields } = challengeD;
  const foreign = Challenge.from({ ...fields, secretKey: `${keys.mppSecretKey}-another-store` });
  await probe(
    ctx,
    "c: challenge from another secret",
    tap("D").verificationId,
    authorization(foreign, await signTransfer(foreign, stack.recipient)),
    "challenge_forged",
  );
  const unrecorded = Challenge.from({
    ...fields,
    expires: new Date(Date.parse(challengeD.expires ?? "") + 1_000).toISOString(),
    secretKey: keys.mppSecretKey,
  });
  assert.ok(
    Challenge.verify(unrecorded, { secretKey: keys.mppSecretKey }),
    "self-built challenge carries this store's HMAC",
  );
  await probe(
    ctx,
    "c: store-HMAC challenge never issued",
    tap("D").verificationId,
    authorization(unrecorded, await signTransfer(unrecorded, stack.recipient)),
    "challenge_not_issued",
  );

  const challengeF = await issueChallenge(stack, tap("F"));
  await probe(
    ctx,
    "f: memo bound to another challenge",
    tap("F").verificationId,
    authorization(
      challengeF,
      await signTransfer(challengeF, stack.recipient, { memoFor: challengeC.id }),
    ),
    "memo_unbound",
  );
  const challengeG = await issueChallenge(stack, tap("G"));
  await probe(
    ctx,
    "g: protocol nonce, not expiring",
    tap("G").verificationId,
    authorization(
      challengeG,
      await signTransfer(challengeG, stack.recipient, { protocolNonce: true }),
    ),
    "nonce_not_expiring",
  );
  const challengeH = await issueChallenge(stack, tap("H"));
  await probe(
    ctx,
    "h: validBefore in the past",
    tap("H").verificationId,
    authorization(
      challengeH,
      await signTransfer(challengeH, stack.recipient, { validBefore: unixNow() - 5 }),
    ),
    "valid_before_window",
  );
  const challengeI = await issueChallenge(stack, tap("I"));
  await probe(
    ctx,
    "i: validBefore 60 s ahead",
    tap("I").verificationId,
    authorization(
      challengeI,
      await signTransfer(challengeI, stack.recipient, { validBefore: unixNow() + 60 }),
    ),
    "valid_before_window",
  );

  const challengeU = await issueChallenge(stack, tap("U"));
  const deadTx = await signTransfer(challengeU, stack.recipient);
  const balanceBeforeDead = await pathUsdBalance(agent.address);
  const sendRawBeforeDead = proxy.seenSendRaw;
  proxy.setMode("drop-before-forward");
  const dropped = await postReorder(
    stack,
    tap("U").verificationId,
    authorization(challengeU, deadTx),
  );
  proxy.setMode("pass");
  console.log(`setup d: dropped broadcast answered HTTP ${dropped.status} ${await dropped.text()}`);
  assert.ok(proxy.seenSendRaw > sendRawBeforeDead, "the store tried to broadcast tap U's transfer");
  const deadAttempt = async () =>
    (
      await stack.query<{ status: string; valid_before: string; created_block: string }>(
        "SELECT status, valid_before, created_block FROM payment_attempts WHERE tx_hash = $1",
        [keccak256(deadTx)],
      )
    ).map((r) => ({ ...r, valid_before: Number(r.valid_before) }))[0];
  const dead = await waitFor(
    async () => ((await deadAttempt())?.status === "dead" ? true : undefined),
    90_000,
    "tap U's dropped attempt to end dead",
  ).catch(() => false);
  const usedName = "d: challenge used by a dead attempt";
  assert.equal(
    await pathUsdBalance(agent.address),
    balanceBeforeDead,
    "the dropped transfer never moved funds",
  );
  if (dead) {
    const [usedAt] = (
      await stack.query<{ used_at: string | null }>(
        "SELECT used_at FROM issued_challenges WHERE challenge_id = $1",
        [challengeU.id],
      )
    ).map((r) => (r.used_at === null ? null : Number(r.used_at)));
    assert.ok(
      typeof usedAt === "number",
      "tap U's challenge was marked used when the attempt was reserved",
    );
    console.log(`setup d: attempt ${keccak256(deadTx)} is dead; challenge used_at ${usedAt}`);
    await probe(
      ctx,
      usedName,
      tap("U").verificationId,
      authorization(challengeU, await signTransfer(challengeU, stack.recipient)),
      "challenge_used",
    );
  } else {
    const row = await deadAttempt();
    assert.ok(row !== undefined, "tap U's dropped transfer was reserved as an attempt");
    const resolution = await createChainProof({
      rpcUrl: MODERATO_RPC,
      pathUsd: PATH_USD,
      recipient: stack.recipient,
      amount: 1_000_000n,
    }).resolveAttempt({
      txHash: keccak256(deadTx),
      payer: agent.address,
      validBefore: row.valid_before,
      createdBlock: BigInt(row.created_block),
    });
    const reason = resolution.kind === "unknown" ? resolution.reason : resolution.kind;
    rows.push({
      name: usedName,
      status: "not sent",
      error: `setup attempt still ${row.status}`,
      reason: `chain-proof: ${reason}`,
      attempts: "-",
      sendRaw: "-",
    });
    check(
      usedName,
      false,
      `dropped attempt ${keccak256(deadTx)} (validBefore ${row.valid_before}) is still ${row.status} 90 s later; resolveAttempt says ${reason}`,
    );
  }

  await priceCapCase(capStack.value);

  const expiresAt = Date.parse(expiring.expires ?? "");
  console.log(
    `e: waiting ${Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000) + 2)} s for tap E's challenge to expire`,
  );
  await sleep(Math.max(0, expiresAt - Date.now() + 2_000));
  await probe(
    ctx,
    "e: challenge past its expires",
    tap("E").verificationId,
    authorization(expiring, await signTransfer(expiring, stack.recipient)),
    "challenge_expired",
  );
} finally {
  await Promise.all(stacks.map((s) => s.stop()));
  await proxy.stop();
}

console.log("\ncase | status | error | store reason | attempts | sendRaw");
for (const r of rows) {
  console.log([r.name, r.status, r.error, r.reason, r.attempts, r.sendRaw].join(" | "));
}
if (failures.length > 0) {
  console.error(`\n${failures.length} failed assertion(s):\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`\nall ${rows.length} adversarial cases refused before broadcast`);
}
