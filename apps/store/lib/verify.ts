import { Receipt } from "mppx";
import { credentialSource, parseCredential } from "./binding";
import { config } from "./config";
import { recordVerification } from "./ledger";
import { mppx } from "./mpp";
import { readTap, TAP_ERROR_STATUS } from "./tap";

const VERIFY_PRICE = "0.001";

/** `POST /api/verify` with body `{ link }`: read the tap from Res Labs, then charge $0.001. */
export async function verify(req: Request): Promise<Response> {
  const body: unknown = await req.json().catch(() => undefined);
  const link = typeof body === "object" && body !== null && "link" in body ? body.link : undefined;
  if (typeof link !== "string") return Response.json({ error: "bad_link" }, { status: 400 });

  // Every request, unpaid or paid, re-reads the tap, so an expired or foreign link is never charged.
  const read = await readTap(link);
  if (read.kind === "rejected") {
    return Response.json({ error: read.error }, { status: TAP_ERROR_STATUS[read.error] });
  }

  // A verification records its payer, so refuse a credential that names none before charging it.
  const authorization = req.headers.get("authorization");
  const credential = authorization === null ? null : parseCredential(authorization);
  const payer = credential === null ? null : credentialSource(credential);
  if (credential !== null && payer === null) {
    return Response.json({ error: "bad_credential" }, { status: 400 });
  }

  const charged = await mppx().charge({ amount: VERIFY_PRICE })(req);
  if (charged.status === 402) return charged.challenge;
  if (payer === null)
    throw new Error("mppx accepted a verify request without a parseable credential");

  const verification = recordVerification({
    ...read.tap,
    payer,
    txHash: Receipt.fromResponse(charged.withReceipt(new Response(null))).reference.toLowerCase(),
  });
  return charged.withReceipt(
    Response.json({
      verification_id: verification.verificationId,
      tap_id: verification.tapId,
      batch_id: verification.batchId,
      batch_code: verification.batchCode,
      product_name: verification.productName,
      vendor_name: verification.vendorName,
      coa_url: verification.coaUrl,
      sku: config.demoSku,
      price: config.demoPrice,
      payer: verification.payer,
      tx_hash: verification.txHash,
      created_at: verification.createdAt,
    }),
  );
}
