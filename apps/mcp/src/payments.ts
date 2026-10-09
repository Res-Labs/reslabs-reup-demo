import { Mppx, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config";

export const MODERATO_CHAIN_ID = 42431;
export const PATH_USD = "0x20c0000000000000000000000000000000000000";
/** 1.10 pathUSD in base units (6 decimals). */
export const MAX_CHARGE = 1_100_000n;
/** 10.00 pathUSD in base units: the most this process will ever sign for. */
export const SPEND_CAP = 10_000_000n;

export type ChargeDecision =
  | { kind: "allow"; amount: bigint; spentAfter: bigint }
  | { kind: "refuse"; reason: string };

export class PaymentRefused extends Error {
  override name = "PaymentRefused";
}

export function decideCharge(request: Record<string, unknown>, spentSoFar: bigint): ChargeDecision {
  const { currency, amount } = request;
  if (typeof currency !== "string" || currency.toLowerCase() !== PATH_USD) {
    return { kind: "refuse", reason: `currency ${String(currency)} is not pathUSD` };
  }
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
    return { kind: "refuse", reason: `amount ${String(amount)} is not a base-unit integer` };
  }
  const charge = BigInt(amount);
  if (charge > MAX_CHARGE) {
    return {
      kind: "refuse",
      reason: `amount ${amount} exceeds the per-charge limit of ${MAX_CHARGE}`,
    };
  }
  const spentAfter = spentSoFar + charge;
  if (spentAfter > SPEND_CAP) {
    return {
      kind: "refuse",
      reason: `amount ${amount} would bring this session's spend to ${spentAfter}, over the cap of ${SPEND_CAP}`,
    };
  }
  return { kind: "allow", amount: charge, spentAfter };
}

/**
 * mppx pays anyway when `onChallenge` returns undefined, so refusal must throw.
 * The running total is reserved before signing and never released: a 402 or 5xx after
 * the credential is sent does not prove the store never broadcast it.
 */
export function createChallengeGuard() {
  let spent = 0n;
  return async (
    challenge: { request: Record<string, unknown> },
    helpers: { createCredential: () => Promise<string> },
  ): Promise<string> => {
    const decision = decideCharge(challenge.request, spent);
    if (decision.kind === "refuse") throw new PaymentRefused(decision.reason);
    spent = decision.spentAfter;
    return helpers.createCredential();
  };
}

export function createPaidFetch(config: Config) {
  const account = privateKeyToAccount(config.agentKey);
  const mppx = Mppx.create({
    polyfill: false,
    maxPaymentRetries: 1,
    methods: [
      tempo({
        account,
        expectedChainId: MODERATO_CHAIN_ID,
        expectedRecipients: [config.mppRecipient],
      }),
    ],
    onChallenge: createChallengeGuard(),
  });
  return { address: account.address, fetch: mppx.fetch };
}
