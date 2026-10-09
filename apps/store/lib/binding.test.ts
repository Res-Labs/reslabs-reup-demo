import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Address, MODERATO_CHAIN_ID, PATH_USD } from "@reup/chain-proof";
import { Challenge, Credential } from "mppx";
import { Proof } from "mppx/tempo";
import {
  concat,
  encodeFunctionData,
  type Hex,
  keccak256,
  maxUint256,
  padHex,
  slice,
  stringToBytes,
} from "viem";
import { Abis, Account } from "viem/tempo";
import { type BindingFailure, bindCredential } from "./binding";
import type { IssuedChallenge } from "./ledger";

const SECRET = "synthetic-store-secret-of-at-least-32-bytes";
const RECIPIENT: Address = "0x00000000000000000000000000000000000000a1";
const STRANGER: Address = "0x00000000000000000000000000000000000000b2";
const PRICE = 1_000_000n;
const TAP_ID = "0b8e4f2a-7c31-4d9e-a5b6-c7d8e9f0a1b2";
const NOW = 1_800_000_000;
const REQUEST = {
  amount: "1000000",
  currency: PATH_USD,
  recipient: RECIPIENT,
  methodDetails: { chainId: MODERATO_CHAIN_ID },
};
const TERMS = { secretKey: SECRET, recipient: RECIPIENT, amount: PRICE, tapId: TAP_ID, now: NOW };

const payer = Account.fromSecp256k1(`0x${"11".repeat(32)}`);

interface Scenario {
  secret?: string;
  request?: Record<string, unknown>;
  payload?: (signature: Hex) => unknown;
  source?: string;
  memoFor?: string;
  memoRealm?: string;
  transfer?: {
    to?: Address;
    amount?: bigint;
    extraCall?: boolean;
    nonceKey?: bigint;
    validBefore?: number;
  };
  issued?: Partial<IssuedChallenge> | null;
}

async function bind(scenario: Scenario = {}) {
  const challenge = Challenge.from({
    secretKey: scenario.secret ?? SECRET,
    realm: "reup-demo-store",
    method: "tempo",
    intent: "charge",
    request: scenario.request ?? REQUEST,
    expires: new Date((NOW + 300) * 1000).toISOString(),
  });
  const memo = concat([
    slice(keccak256(stringToBytes("mpp")), 0, 4),
    "0x01",
    slice(keccak256(stringToBytes(scenario.memoRealm ?? challenge.realm)), 0, 10),
    padHex("0x", { size: 10 }),
    slice(keccak256(stringToBytes(scenario.memoFor ?? challenge.id)), 0, 7),
  ]);
  const transfer = scenario.transfer ?? {};
  const call = {
    to: PATH_USD,
    data: encodeFunctionData({
      abi: Abis.tip20,
      functionName: "transferWithMemo",
      args: [transfer.to ?? RECIPIENT, transfer.amount ?? PRICE, memo],
    }),
  };
  const signature = await payer.signTransaction({
    chainId: MODERATO_CHAIN_ID,
    calls: transfer.extraCall ? [call, call] : [call],
    nonceKey: transfer.nonceKey ?? maxUint256,
    nonce: 0,
    validBefore: transfer.validBefore ?? NOW + 25,
    gas: 100_000n,
    maxFeePerGas: 20_000_000_000n,
    maxPriorityFeePerGas: 1n,
  });
  const authorization = Credential.serialize({
    challenge,
    payload: scenario.payload?.(signature) ?? { type: "transaction", signature },
    source:
      scenario.source ?? Proof.proofSource({ address: payer.address, chainId: MODERATO_CHAIN_ID }),
  });
  const issued: IssuedChallenge | undefined =
    scenario.issued === null
      ? undefined
      : {
          challengeId: challenge.id,
          tapId: TAP_ID,
          amount: "1000000",
          expires: NOW + 300,
          usedAt: null,
          ...scenario.issued,
        };
  const result = await bindCredential(
    authorization,
    (id) => (id === challenge.id ? issued : undefined),
    TERMS,
  );
  return { result, challenge, signature };
}

describe("bindCredential", () => {
  it("binds a credential issued for this tap to the hash of its signed transaction", async () => {
    const { result, challenge, signature } = await bind();
    assert.deepEqual(result, {
      ok: true,
      txHash: keccak256(signature),
      payer: payer.address,
      validBefore: NOW + 25,
      challengeId: challenge.id,
    });
  });

  it("accepts validBefore exactly 30 s ahead", async () => {
    const { result } = await bind({ transfer: { validBefore: NOW + 30 } });
    assert.equal(result.ok, true);
  });

  it("rejects an Authorization header without a Payment credential", async () => {
    assert.deepEqual(await bindCredential("Bearer synthetic", () => undefined, TERMS), {
      ok: false,
      reason: "unparseable",
    });
  });

  const rejections: [string, Scenario, BindingFailure][] = [
    [
      "a push (hash) credential",
      { payload: () => ({ type: "hash", hash: `0x${"ab".repeat(32)}` }) },
      "not_transaction",
    ],
    [
      "a challenge signed with another key",
      { secret: "another-synthetic-secret-of-32-bytes-min" },
      "challenge_forged",
    ],
    ["a challenge the store never recorded", { issued: null }, "challenge_not_issued"],
    [
      "a challenge issued for another tap",
      { issued: { tapId: "7a2e3d4c-5b6a-4f79-8e0d-9c1b2a3f4e5d" } },
      "challenge_not_issued",
    ],
    ["a challenge already used", { issued: { usedAt: NOW - 5 } }, "challenge_used"],
    ["an expired challenge", { issued: { expires: NOW } }, "challenge_expired"],
    ["a $0.001 verify challenge", { request: { ...REQUEST, amount: "1000" } }, "challenge_terms"],
    [
      "a challenge paying another recipient",
      { request: { ...REQUEST, recipient: STRANGER } },
      "challenge_terms",
    ],
    [
      "a challenge for another chain",
      { request: { ...REQUEST, methodDetails: { chainId: 4217 } } },
      "challenge_terms",
    ],
    [
      "a non-Tempo transaction",
      { payload: () => ({ type: "transaction", signature: "0x02f8" }) },
      "not_tempo_transaction",
    ],
    [
      "a source that did not sign",
      { source: Proof.proofSource({ address: STRANGER, chainId: MODERATO_CHAIN_ID }) },
      "sender_mismatch",
    ],
    ["a transfer to another recipient", { transfer: { to: STRANGER } }, "transfer_mismatch"],
    ["a transfer of another amount", { transfer: { amount: PRICE - 1n } }, "transfer_mismatch"],
    ["a second call", { transfer: { extraCall: true } }, "transfer_mismatch"],
    ["a memo bound to another challenge", { memoFor: "another-challenge-id" }, "memo_unbound"],
    ["a memo for another server", { memoRealm: "another-store" }, "memo_unbound"],
    ["a sequential nonce", { transfer: { nonceKey: 0n } }, "nonce_not_expiring"],
    ["a validBefore already passed", { transfer: { validBefore: NOW } }, "valid_before_window"],
    [
      "a validBefore more than 30 s ahead",
      { transfer: { validBefore: NOW + 31 } },
      "valid_before_window",
    ],
  ];

  for (const [name, scenario, reason] of rejections) {
    it(`rejects ${name} before broadcast`, async () => {
      assert.deepEqual((await bind(scenario)).result, { ok: false, reason });
    });
  }
});
