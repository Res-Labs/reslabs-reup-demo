import { type Address, type Hex, MODERATO_CHAIN_ID, PATH_USD } from "@reup/chain-proof";
import { Challenge, Credential } from "mppx";
import { Methods, Proof } from "mppx/tempo";
import {
  decodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  keccak256,
  maxUint256,
  stringToBytes,
} from "viem";
import { Abis, Transaction } from "viem/tempo";
import type { IssuedChallenge } from "./ledger";

export interface BindingTerms {
  secretKey: string;
  recipient: Address;
  amount: bigint;
  tapId: string;
  now: number;
}

export type BindingFailure =
  | "unparseable"
  | "not_transaction"
  | "challenge_forged"
  | "challenge_not_issued"
  | "challenge_used"
  | "challenge_expired"
  | "challenge_terms"
  | "not_tempo_transaction"
  | "sender_mismatch"
  | "transfer_mismatch"
  | "memo_unbound"
  | "nonce_not_expiring"
  | "valid_before_window";

export type Binding =
  | { ok: true; txHash: Hex; payer: Address; validBefore: number; challengeId: string }
  | { ok: false; reason: BindingFailure };

/** The canonical tempo charge request this store's mppx instance puts in every challenge it signs. */
interface IssuedChargeRequest {
  amount?: string;
  currency?: string;
  recipient?: string;
  methodDetails?: { chainId?: number };
}

const MAX_VALID_BEFORE_SECONDS = 30;
const MPP_MEMO_TAG = keccak256(stringToBytes("mpp")).slice(2, 10);

function sameAddress(value: string | undefined, expected: Address): boolean {
  return (
    value !== undefined && isAddress(value, { strict: false }) && isAddressEqual(value, expected)
  );
}

export function parseCredential(authorization: string): Credential.Credential | null {
  const payment = Credential.extractPaymentScheme(authorization);
  if (payment === null) return null;
  try {
    return Credential.deserialize(payment);
  } catch {
    return null;
  }
}

export function credentialSource(credential: Credential.Credential): Address | null {
  const source = credential.source === undefined ? null : Proof.parsePkhSource(credential.source);
  return source?.chainId === MODERATO_CHAIN_ID ? getAddress(source.address) : null;
}

/**
 * Steps 1-3 of a paid reorder: authenticate the challenge, bind the signed transaction to it,
 * and derive the hash mppx will broadcast. Nothing here touches the chain.
 */
export async function bindCredential(
  authorization: string,
  issuedChallenge: (challengeId: string) => IssuedChallenge | undefined,
  terms: BindingTerms,
): Promise<Binding> {
  const fail = (reason: BindingFailure): Binding => ({ ok: false, reason });

  const credential = parseCredential(authorization);
  if (credential === null) return fail("unparseable");
  const { challenge } = credential;

  const parsed = Methods.charge.schema.credential.payload.safeParse(credential.payload);
  const payload = parsed.success ? parsed.data : undefined;
  if (payload?.type !== "transaction") return fail("not_transaction");
  if (!Challenge.verify(challenge, { secretKey: terms.secretKey })) return fail("challenge_forged");
  const issued = issuedChallenge(challenge.id);
  if (issued === undefined || issued.tapId !== terms.tapId) return fail("challenge_not_issued");
  if (issued.usedAt !== null) return fail("challenge_used");
  if (issued.expires <= terms.now) return fail("challenge_expired");
  // Challenge.verify passed, so this request is one this store signed.
  const request = challenge.request as IssuedChargeRequest;
  if (
    request.amount !== terms.amount.toString() ||
    !sameAddress(request.currency, PATH_USD) ||
    !sameAddress(request.recipient, terms.recipient) ||
    request.methodDetails?.chainId !== MODERATO_CHAIN_ID
  ) {
    return fail("challenge_terms");
  }

  const { signature } = payload;
  if (!signature.toLowerCase().startsWith("0x76")) return fail("not_tempo_transaction");
  const tx = (() => {
    try {
      return Transaction.deserialize(signature as `0x76${string}`);
    } catch {
      return null;
    }
  })();
  if (tx === null) return fail("not_tempo_transaction");

  const payer = credentialSource(credential);
  if (tx.from === undefined || payer === null || !isAddressEqual(tx.from, payer)) {
    return fail("sender_mismatch");
  }

  const [call, ...otherCalls] = tx.calls;
  if (call?.data === undefined || otherCalls.length > 0 || !sameAddress(call.to, PATH_USD)) {
    return fail("transfer_mismatch");
  }
  const { data } = call;
  const transfer = (() => {
    try {
      return decodeFunctionData({ abi: Abis.tip20, data });
    } catch {
      return null;
    }
  })();
  if (transfer?.functionName !== "transferWithMemo") return fail("transfer_mismatch");
  const [to, value, memo] = transfer.args;
  if (!isAddressEqual(to, terms.recipient) || value !== terms.amount)
    return fail("transfer_mismatch");

  // mppx's Attribution memo checks are not exported. These mirror what mppx verifies before
  // broadcast (verifyServer + verifyChallengeBinding), so no attempt is reserved for a memo
  // mppx would refuse: bytes 0-3 keccak256("mpp")[0:4], byte 4 version 0x01,
  // bytes 5-14 keccak256(realm)[0:10], bytes 25-31 keccak256(challenge.id)[0:7].
  const memoHex = memo.toLowerCase();
  if (
    memoHex.length !== 66 ||
    memoHex.slice(2, 10) !== MPP_MEMO_TAG ||
    memoHex.slice(10, 12) !== "01" ||
    memoHex.slice(12, 32) !== keccak256(stringToBytes(challenge.realm)).slice(2, 22) ||
    memoHex.slice(52, 66) !== keccak256(stringToBytes(challenge.id)).slice(2, 16)
  ) {
    return fail("memo_unbound");
  }

  if (tx.nonceKey !== maxUint256) return fail("nonce_not_expiring");
  const { validBefore } = tx;
  if (
    validBefore === undefined ||
    validBefore <= terms.now ||
    validBefore > terms.now + MAX_VALID_BEFORE_SECONDS
  ) {
    return fail("valid_before_window");
  }

  return {
    ok: true,
    txHash: keccak256(await Transaction.serialize(tx)),
    payer: getAddress(tx.from),
    validBefore,
    challengeId: challenge.id,
  };
}
