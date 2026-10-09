import {
  type Address,
  type Attempt,
  classifyBlocks,
  classifyReceipt,
  type Resolution,
} from "./resolve";
import { createRpcBatch, getBlock, parseBlock, parseReceipt, type RpcCall } from "./rpc";

export type { Address, Attempt, Hex, Resolution } from "./resolve";

export const PATH_USD: Address = "0x20c0000000000000000000000000000000000000";
export const MODERATO_CHAIN_ID = 42431;

// The usual dead-proof range is ~75 blocks and fits one batch. A late reconciler run
// walks a longer range in windows instead of one unbounded batch.
const BLOCKS_PER_BATCH = 100n;

export interface ChainProofConfig {
  rpcUrl: string;
  pathUsd: Address;
  recipient: Address;
  amount: bigint;
  fetch?: typeof fetch;
}

export interface ChainProof {
  finalizedBlockNumber(): Promise<bigint>;
  resolveAttempt(attempt: Attempt): Promise<Resolution>;
}

export function createChainProof(config: ChainProofConfig): ChainProof {
  const batch = createRpcBatch(config.rpcUrl, config.fetch ?? fetch);

  async function resolve(attempt: Attempt): Promise<Resolution> {
    const [finalized, receipt] = await batch([
      getBlock("finalized"),
      { method: "eth_getTransactionReceipt", params: [attempt.txHash] },
    ]);
    const verdict = classifyReceipt(attempt, config, parseBlock(finalized), parseReceipt(receipt));
    if (verdict.kind !== "scan-blocks") return verdict;
    for (let from = verdict.from; from <= verdict.through; from += BLOCKS_PER_BATCH) {
      const calls: RpcCall[] = [];
      for (let n = from; n < from + BLOCKS_PER_BATCH && n <= verdict.through; n++) {
        calls.push(getBlock(n));
      }
      const scan = classifyBlocks(attempt, from, (await batch(calls)).map(parseBlock));
      if (scan.kind !== "keep-scanning") return scan;
    }
    return {
      kind: "unknown",
      reason: `no block through finalized block ${verdict.through} reached validBefore`,
    };
  }

  return {
    async finalizedBlockNumber() {
      const [raw] = await batch([getBlock("finalized")]);
      const block = parseBlock(raw);
      if (!block) throw new Error("RPC returned no finalized block");
      return block.number;
    },
    async resolveAttempt(attempt) {
      try {
        return await resolve(attempt);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { kind: "unknown", reason };
      }
    },
  };
}
