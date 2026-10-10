import { setTimeout as sleep } from "node:timers/promises";
import { type ChainProof, createChainProof, PATH_USD, type Resolution } from "@reup/chain-proof";
import { Challenge, Receipt } from "mppx";
import { bindCredential, parseCredential } from "./binding";
import { config } from "./config";
import {
  type AttemptState,
  attemptExists,
  attemptState,
  findIssuedChallenge,
  findOrderByTap,
  findVerification,
  formatAmount,
  listPendingAttempts,
  markResolved,
  type Order,
  openAttemptStatus,
  type PaymentAttempt,
  recordIssuedChallenge,
  reserveAttempt,
  settle,
  unixNow,
  type Verification,
} from "./ledger";
import { mppx } from "./mpp";

const VERIFICATION_TTL_SECONDS = 15 * 60;
const INLINE_GRACE_SECONDS = 15;
const INLINE_POLL_MS = 1_000;
const RECONCILE_INTERVAL_MS = 15_000;
const EXPLORER_TX_URL = "https://explore.testnet.tempo.xyz/tx/";

const OPEN_ATTEMPT_ERROR = { pending: "settlement_pending", review: "needs_review" } as const;

let proof: ChainProof | undefined;

function chainProof(): ChainProof {
  proof ??= createChainProof({
    rpcUrl: config.tempoRpcUrl,
    pathUsd: PATH_USD,
    recipient: config.mppRecipient,
    amount: config.demoPriceUnits,
  });
  return proof;
}

function errorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function orderBody(order: Order, alreadyOrdered: boolean) {
  return {
    order_id: order.orderId,
    tap_id: order.tapId,
    amount: formatAmount(order.amount),
    payer: order.payer,
    tx_hash: order.txHash,
    explorer_url: `${EXPLORER_TX_URL}${order.txHash}`,
    already_ordered: alreadyOrdered,
  };
}

/** `POST /api/reorder` with body `{ verification_id }` and nothing else. */
export async function reorder(req: Request): Promise<Response> {
  const body: unknown = await req.json().catch(() => undefined);
  const verificationId =
    typeof body === "object" &&
    body !== null &&
    Object.keys(body).length === 1 &&
    "verification_id" in body
      ? body.verification_id
      : undefined;
  if (typeof verificationId !== "string") return errorResponse(400, "bad_request");
  return everyReorderRequest(req, verificationId);
}

async function everyReorderRequest(req: Request, verificationId: string): Promise<Response> {
  const verification = await findVerification(verificationId);
  if (verification === undefined) return errorResponse(404, "unknown_verification");

  // The instance that reserved a pending attempt may be gone, so each request resolves it once.
  await reconcile(verification.tapId);
  const order = await findOrderByTap(verification.tapId);
  if (order !== undefined) return Response.json(orderBody(order, true));
  const open = await openAttemptStatus(verification.tapId);
  if (open !== undefined) return errorResponse(409, OPEN_ATTEMPT_ERROR[open]);

  if (unixNow() - verification.createdAt > VERIFICATION_TTL_SECONDS) {
    return errorResponse(410, "verification_expired");
  }
  const authorization = req.headers.get("authorization");
  if (authorization === null) return issueChallenge(req, verification.tapId);
  return payWithCredential(req, verification, authorization);
}

/** Issues a reorder challenge for this tap and records it, so only this tap can spend it. */
async function issueChallenge(req: Request, tapId: string): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete("authorization");
  const result = await mppx().charge({ amount: config.demoPrice })(
    new Request(req.url, { method: req.method, headers }),
  );
  if (result.status !== 402)
    throw new Error("mppx accepted a reorder request without a credential");
  const challenge = Challenge.fromResponse(result.challenge);
  if (challenge.expires === undefined) throw new Error("mppx issued a challenge without expires");
  await recordIssuedChallenge({
    challengeId: challenge.id,
    tapId,
    amount: String(challenge.request.amount),
    expires: Math.floor(Date.parse(challenge.expires) / 1000),
  });
  return result.challenge;
}

async function payWithCredential(
  req: Request,
  verification: Verification,
  authorization: string,
): Promise<Response> {
  // bindCredential looks the challenge up synchronously, so it is read first.
  const challengeId = parseCredential(authorization)?.challenge.id;
  const issued = challengeId === undefined ? undefined : await findIssuedChallenge(challengeId);
  const binding = await bindCredential(
    authorization,
    (id) => (id === issued?.challengeId ? issued : undefined),
    {
      secretKey: config.mppSecretKey,
      recipient: config.mppRecipient,
      amount: config.demoPriceUnits,
      tapId: verification.tapId,
      now: unixNow(),
    },
  );
  if (!binding.ok) {
    console.warn(`reorder: credential rejected before broadcast (${binding.reason})`);
    return errorResponse(400, "bad_credential");
  }
  if (await attemptExists(binding.txHash)) return errorResponse(409, "credential_reused");

  const attempt: PaymentAttempt = {
    txHash: binding.txHash,
    tapId: verification.tapId,
    payer: binding.payer,
    validBefore: binding.validBefore,
    createdBlock: await chainProof().finalizedBlockNumber(),
  };
  if (!(await reserveAttempt(attempt, binding.challengeId))) {
    return everyReorderRequest(req, verification.verificationId);
  }

  // mppx answers 402 for every verify or broadcast failure, including after a successful
  // broadcast, so only a 200 carrying the reserved hash settles without asking the chain.
  const charged = await mppx()
    .charge({ amount: config.demoPrice })(req)
    .catch(() => undefined);
  if (charged?.status === 200) {
    const reference = Receipt.fromResponse(
      charged.withReceipt(new Response(null)),
    ).reference.toLowerCase();
    if (reference !== attempt.txHash) {
      await markResolved(
        attempt.txHash,
        "review",
        `mppx receipt reference ${reference} differs from reserved ${attempt.txHash}`,
      );
      return errorResponse(409, "needs_review");
    }
    const state = await settle(attempt, config.demoPriceUnits);
    if (state.status === "paid")
      return charged.withReceipt(Response.json(orderBody(state.order, false)));
    return respondToAttempt(req, attempt.tapId, state);
  }

  const deadline = (attempt.validBefore + INLINE_GRACE_SECONDS) * 1000;
  for (;;) {
    const resolution = await chainProof().resolveAttempt(attempt);
    if (resolution.kind !== "unknown") {
      await applyResolution(attempt, resolution);
      break;
    }
    if (Date.now() >= deadline) break;
    await sleep(INLINE_POLL_MS);
  }
  return respondToAttempt(req, attempt.tapId, await attemptState(attempt.txHash));
}

async function respondToAttempt(
  req: Request,
  tapId: string,
  state: AttemptState,
): Promise<Response> {
  switch (state.status) {
    case "paid":
      return Response.json(orderBody(state.order, false));
    case "review":
      return errorResponse(409, "needs_review");
    case "pending":
      return errorResponse(503, "settlement_pending");
    case "dead": {
      const challenge = await issueChallenge(req, tapId);
      const headers = new Headers(challenge.headers);
      headers.set("Content-Type", "application/json");
      return new Response(JSON.stringify({ error: "payment_not_settled" }), {
        status: 402,
        headers,
      });
    }
  }
}

/** The one table the inline resolution and `reconcile` both apply. */
async function applyResolution(attempt: PaymentAttempt, resolution: Resolution): Promise<void> {
  switch (resolution.kind) {
    case "settled-paid":
      await settle(attempt, config.demoPriceUnits);
      return;
    case "settled-no-transfer":
      await markResolved(
        attempt.txHash,
        "review",
        `included in block ${resolution.blockNumber} without a matching TransferWithMemo`,
      );
      return;
    case "reverted-no-transfer":
      await markResolved(
        attempt.txHash,
        "dead",
        `reverted in block ${resolution.blockNumber}; nothing reached the recipient`,
      );
      return;
    case "dead":
      await markResolved(
        attempt.txHash,
        "dead",
        "no block up to validBefore includes the transaction",
      );
      return;
    case "unknown":
      return;
  }
}

/**
 * Resolves every pending attempt once, or only the tap's when `tapId` is given, and returns how
 * many it checked. Attempts change only on a final `resolveAttempt` result for their own hash:
 * never by sender, recipient or amount, and never because time passed. Every write it makes is
 * conditional or idempotent, so concurrent passes from several instances converge.
 */
export async function reconcile(tapId?: string): Promise<number> {
  const pending = await listPendingAttempts(tapId);
  for (const attempt of pending) {
    await applyResolution(attempt, await chainProof().resolveAttempt(attempt));
  }
  return pending.length;
}

/** Runs `reconcile` on boot and every 15 s in a long-lived process such as `next start`. */
export function startReconciler(): void {
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      await reconcile();
    } catch (error) {
      console.error("reconciler pass failed:", error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };
  void pass();
  setInterval(pass, RECONCILE_INTERVAL_MS).unref();
}
