import { hexToBigInt, hexToNumber, isAddress, isHex, numberToHex } from "viem";
import type { Address, Block, Hex, Log, Receipt } from "./resolve";

// Same default as viem's HTTP transport.
const TIMEOUT_MS = 10_000;

export interface RpcCall {
  method: string;
  params: readonly unknown[];
}

export type RpcBatch = (calls: readonly RpcCall[]) => Promise<unknown[]>;

export function createRpcBatch(url: string, fetchFn: typeof fetch): RpcBatch {
  return async (calls) => {
    const requests = calls.map((call, id) => ({ jsonrpc: "2.0", id, ...call }));
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requests),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const replies: unknown = await response.json();
    if (!Array.isArray(replies)) throw new Error("RPC batch response is not an array");
    const results = new Map<unknown, unknown>();
    for (const reply of replies) {
      const { id, error, result } = record(reply, "RPC batch entry");
      if (error !== undefined) throw new Error(`RPC error: ${JSON.stringify(error)}`);
      results.set(id, result);
    }
    return calls.map((_, id) => {
      if (!results.has(id)) throw new Error(`RPC batch response has no entry for id ${id}`);
      return results.get(id);
    });
  };
}

export function getBlock(number: bigint | "finalized"): RpcCall {
  return {
    method: "eth_getBlockByNumber",
    params: [typeof number === "bigint" ? numberToHex(number) : number, false],
  };
}

export function parseBlock(raw: unknown): Block | null {
  if (raw === null) return null;
  const block = record(raw, "block");
  const transactions = list(block.transactions, "block.transactions");
  return {
    number: hexToBigInt(hex(block.number, "block.number")),
    timestamp: hexToNumber(hex(block.timestamp, "block.timestamp")),
    transactions: transactions.map((tx) => hex(tx, "block.transactions[]")),
  };
}

export function parseReceipt(raw: unknown): Receipt | null {
  if (raw === null) return null;
  const receipt = record(raw, "receipt");
  return {
    blockNumber: hexToBigInt(hex(receipt.blockNumber, "receipt.blockNumber")),
    status: receiptStatus(receipt.status),
    logs: list(receipt.logs, "receipt.logs").map(parseLog),
  };
}

function receiptStatus(value: unknown): Receipt["status"] {
  if (value === "0x1") return "success";
  if (value === "0x0") return "reverted";
  throw new Error(`receipt.status ${String(value)} is neither 0x1 nor 0x0`);
}

function parseLog(raw: unknown): Log {
  const log = record(raw, "log");
  return {
    address: address(log.address, "log.address"),
    topics: list(log.topics, "log.topics").map((topic) => hex(topic, "log.topics[]")),
    data: hex(log.data, "log.data"),
  };
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not an array`);
  return value;
}

function hex(value: unknown, what: string): Hex {
  if (!isHex(value)) throw new Error(`${what} is not hex`);
  return value;
}

function address(value: unknown, what: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new Error(`${what} is not an address`);
  }
  return value;
}
