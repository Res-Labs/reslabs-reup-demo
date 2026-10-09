import { decodeEventLog, isAddressEqual, parseAbiItem, toEventSelector } from "viem";

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export interface Attempt {
  txHash: Hex;
  payer: Address;
  validBefore: number; // unix seconds, exclusive
  createdBlock: bigint;
}

export type Resolution =
  | { kind: "settled-paid"; blockNumber: bigint }
  | { kind: "settled-no-transfer"; blockNumber: bigint }
  | { kind: "reverted-no-transfer"; blockNumber: bigint }
  | { kind: "dead" }
  | { kind: "unknown"; reason: string };

type Unknown = Extract<Resolution, { kind: "unknown" }>;

export interface Payment {
  pathUsd: Address;
  recipient: Address;
  amount: bigint;
}

export interface Block {
  number: bigint;
  timestamp: number;
  transactions: readonly Hex[];
}

export interface Log {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
}

export interface Receipt {
  blockNumber: bigint;
  status: "success" | "reverted";
  logs: readonly Log[];
}

export type ReceiptVerdict = Resolution | { kind: "scan-blocks"; from: bigint; through: bigint };

export type BlockScanVerdict =
  | Extract<Resolution, { kind: "dead" }>
  | Unknown
  | { kind: "keep-scanning" };

const transferWithMemo = parseAbiItem(
  "event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)",
);
const TRANSFER_WITH_MEMO = toEventSelector(transferWithMemo);

// A receive policy can divert a successful transfer without this log, and the log is
// checked on reverted receipts too because "reverts move nothing" is only inferred.
const OUTCOME = {
  success: { paid: "settled-paid", unpaid: "settled-no-transfer" },
  reverted: { paid: "settled-no-transfer", unpaid: "reverted-no-transfer" },
} as const;

export function classifyReceipt(
  attempt: Attempt,
  payment: Payment,
  finalized: Block | null,
  receipt: Receipt | null,
): ReceiptVerdict {
  if (!finalized) return unknown("RPC returned no finalized block");
  if (receipt) {
    if (receipt.blockNumber > finalized.number) {
      return unknown(
        `receipt block ${receipt.blockNumber} is above finalized block ${finalized.number}`,
      );
    }
    const paid = receipt.logs.some((log) => isPayment(log, attempt.payer, payment));
    return {
      kind: OUTCOME[receipt.status][paid ? "paid" : "unpaid"],
      blockNumber: receipt.blockNumber,
    };
  }
  if (finalized.timestamp >= attempt.validBefore) {
    return { kind: "scan-blocks", from: attempt.createdBlock, through: finalized.number };
  }
  return unknown(`no receipt and finalized block ${finalized.number} is before validBefore`);
}

// `blocks` are consecutive, starting at block number `from`. Block timestamps never
// decrease and validBefore is exclusive, so no block after the first one at or past
// validBefore can include the transaction.
export function classifyBlocks(
  attempt: Attempt,
  from: bigint,
  blocks: readonly (Block | null)[],
): BlockScanVerdict {
  const txHash = attempt.txHash.toLowerCase();
  for (const [index, block] of blocks.entries()) {
    if (!block) return unknown(`RPC returned null for block ${from + BigInt(index)}`);
    if (block.transactions.some((hash) => hash.toLowerCase() === txHash)) {
      return unknown(`transaction is in block ${block.number} but has no receipt`);
    }
    if (block.timestamp >= attempt.validBefore) return { kind: "dead" };
  }
  return { kind: "keep-scanning" };
}

function isPayment(log: Log, payer: Address, payment: Payment): boolean {
  const [topic0, ...rest] = log.topics;
  if (topic0 !== TRANSFER_WITH_MEMO) return false;
  if (!isAddressEqual(log.address, payment.pathUsd)) return false;
  const { args } = decodeEventLog({
    abi: [transferWithMemo],
    topics: [topic0, ...rest],
    data: log.data,
  });
  return (
    isAddressEqual(args.from, payer) &&
    isAddressEqual(args.to, payment.recipient) &&
    args.amount === payment.amount
  );
}

function unknown(reason: string): Unknown {
  return { kind: "unknown", reason };
}
