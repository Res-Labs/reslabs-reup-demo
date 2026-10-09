import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import {
  chain,
  EXPLORER_TX,
  loadKeys,
  type McpClient,
  pathUsdBalance,
  type Stack,
  startStack,
  toolField,
  type Wallet,
  waitFor,
} from "./harness";

const VERIFY_FEE = 1_000n;
const REORDER_PRICE = 1_000_000n;

interface Verified {
  verificationId: string;
  tapId: string;
  txHash: Hex;
}

interface Ordered {
  orderId: string;
  txHash: Hex;
  alreadyOrdered: boolean;
}

interface RunSummary {
  run: number;
  tap: string;
  verifyTx: Hex;
  orderId: string;
  reorderTx: Hex;
  reverifyTx: Hex;
  recipientDelta: bigint;
}

function txHashOf(url: string): Hex {
  assert.ok(url.startsWith(EXPLORER_TX), `explorer URL ${url} is on ${EXPLORER_TX}`);
  const hash = url.slice(EXPLORER_TX.length);
  assert.match(hash, /^0x[0-9a-f]{64}$/, `explorer URL ${url} ends in a lowercase tx hash`);
  return hash as Hex;
}

async function verifyTap(
  client: McpClient,
  link: string,
  stack: Stack,
  payer: Address,
): Promise<Verified> {
  const { isError, text } = await client.callTool("reslabs_verify_tap", { link });
  assert.equal(isError, false, `reslabs_verify_tap succeeded:\n${text}`);
  assert.equal(toolField(text, "Product"), "Demo Compound 10 mg", "verify returns the product");
  assert.equal(toolField(text, "Vendor"), "Demo Vendor", "verify returns the vendor");
  assert.equal(
    toolField(text, "Vendor batch"),
    `DEMO-0001 (batch ${stack.batchId})`,
    "verify returns the batch",
  );
  assert.equal(
    toolField(text, "Reorder"),
    "1x DEMO-10MG for 1.00 pathUSD (Tempo Moderato testnet)",
    "verify returns the SKU and price",
  );
  assert.equal(
    toolField(text, "Payer (the agent's wallet)"),
    payer,
    "verify returns the agent as payer",
  );
  const verified = {
    verificationId: toolField(text, "verification_id"),
    tapId: toolField(text, "Tap"),
    txHash: txHashOf(toolField(text, "Verification fee transaction")),
  };
  assert.match(verified.verificationId, /^ver_[a-z2-7]{26}$/, "verify returns a verification_id");
  return verified;
}

async function reorder(
  client: McpClient,
  verificationId: string,
  payer: Address,
): Promise<Ordered> {
  const { isError, text } = await client.callTool("reslabs_reorder", {
    verification_id: verificationId,
  });
  assert.equal(isError, false, `reslabs_reorder succeeded:\n${text}`);
  assert.equal(toolField(text, "Amount"), "1.00 pathUSD", "reorder charges 1.00 pathUSD");
  assert.equal(
    toolField(text, "Payer (the agent's wallet)"),
    payer,
    "reorder returns the agent as payer",
  );
  const ordered = {
    orderId: toolField(text, "order_id"),
    txHash: txHashOf(toolField(text, "Transaction")),
    alreadyOrdered: toolField(text, "already_ordered") === "true",
  };
  assert.match(ordered.orderId, /^ord_[a-z2-7]{26}$/, "reorder returns an order_id");
  return ordered;
}

async function settledTransfer(hash: Hex, from: Address): Promise<bigint> {
  const receipt = await chain.waitForTransactionReceipt({ hash, timeout: 60_000 });
  assert.equal(receipt.status, "success", `${hash} succeeded on Moderato`);
  assert.equal(receipt.from.toLowerCase(), from.toLowerCase(), `${hash} was sent by the agent`);
  return receipt.blockNumber;
}

async function balanceAt(address: Address, blockNumber: bigint): Promise<bigint> {
  return waitFor(
    () => pathUsdBalance(address, blockNumber),
    30_000,
    `balance at block ${blockNumber}`,
  );
}

async function opensOnExplorer(hash: Hex): Promise<void> {
  await waitFor(
    async () => ((await fetch(`${EXPLORER_TX}${hash}`)).status === 200 ? true : undefined),
    30_000,
    `explorer page for ${hash}`,
  );
}

async function happyRun(stack: Stack, agent: Wallet, run: number): Promise<RunSummary> {
  const client = await stack.mcpClient(agent.pk);
  try {
    const link = await stack.mint();
    const before = await pathUsdBalance(stack.recipient);

    const verified = await verifyTap(client, link, stack, agent.address);
    const verifyBlock = await settledTransfer(verified.txHash, agent.address);
    await opensOnExplorer(verified.txHash);
    const afterVerify = await balanceAt(stack.recipient, verifyBlock);
    assert.equal(
      afterVerify - before,
      VERIFY_FEE,
      "recipient received exactly the 0.001 verify fee",
    );

    const order = await reorder(client, verified.verificationId, agent.address);
    assert.equal(order.alreadyOrdered, false, "first reorder places a new order");
    const reorderBlock = await settledTransfer(order.txHash, agent.address);
    await opensOnExplorer(order.txHash);
    const afterReorder = await balanceAt(stack.recipient, reorderBlock);
    assert.equal(
      afterReorder - afterVerify,
      REORDER_PRICE,
      "recipient received exactly the 1.00 reorder price",
    );
    assert.equal(
      afterReorder - before,
      VERIFY_FEE + REORDER_PRICE,
      "verify + reorder paid exactly 1.001",
    );

    const html = await (await fetch(`${stack.storeUrl}/orders`)).text();
    assert.ok(html.includes(order.orderId), "/orders lists the order id");
    assert.ok(html.includes(order.txHash), "/orders links the reorder tx");
    assert.ok(html.toLowerCase().includes(agent.address.toLowerCase()), "/orders shows the payer");

    const sameVerification = await reorder(client, verified.verificationId, agent.address);
    assert.deepEqual(
      sameVerification,
      { ...order, alreadyOrdered: true },
      "second reorder with the same verification returns the existing order",
    );

    const reverified = await verifyTap(client, link, stack, agent.address);
    assert.equal(
      reverified.tapId,
      verified.tapId,
      "re-verifying the same link serves the same tap",
    );
    assert.notEqual(
      reverified.verificationId,
      verified.verificationId,
      "re-verify issues a new verification_id",
    );
    await settledTransfer(reverified.txHash, agent.address);

    const newVerification = await reorder(client, reverified.verificationId, agent.address);
    assert.deepEqual(
      newVerification,
      { ...order, alreadyOrdered: true },
      "reorder with a new verification of the same tap returns the existing order",
    );

    const head = await chain.getBlockNumber();
    const settledHead = await waitFor(
      async () => {
        const n = await chain.getBlockNumber();
        return n > head + 1n ? n : undefined;
      },
      30_000,
      "two more blocks after the duplicate reorders",
    );
    const after = await balanceAt(stack.recipient, settledHead);
    assert.equal(
      after - afterReorder,
      VERIFY_FEE,
      "duplicate reorders paid nothing; only the re-verify fee landed",
    );

    return {
      run,
      tap: verified.tapId,
      verifyTx: verified.txHash,
      orderId: order.orderId,
      reorderTx: order.txHash,
      reverifyTx: reverified.txHash,
      recipientDelta: after - before,
    };
  } finally {
    await client.close();
  }
}

const agent = loadKeys().agents[1];
assert.ok(agent !== undefined, ".e2e/keys.json has agents[1]");
const stack = await startStack();
console.log(
  `run ${stack.runId}: store ${stack.storeUrl}, mock ${stack.mockUrl}, recipient ${stack.recipient}`,
);
const runs: RunSummary[] = [];
try {
  for (const run of [1, 2, 3]) {
    runs.push(await happyRun(stack, agent, run));
    console.log(`run ${run} passed`);
  }
} finally {
  await stack.stop();
}

console.log(
  "\nrun | tap | order | verify tx | reorder tx | re-verify tx | recipient delta (pathUSD)",
);
for (const r of runs) {
  console.log(
    [
      r.run,
      r.tap,
      r.orderId,
      r.verifyTx,
      r.reorderTx,
      r.reverifyTx,
      Number(r.recipientDelta) / 1e6,
    ].join(" | "),
  );
}
console.log(`\nexplorer: ${EXPLORER_TX}<tx>`);
