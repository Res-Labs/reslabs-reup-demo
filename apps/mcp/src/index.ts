import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { parseConfig } from "./config";
import { createPaidFetch, PaymentRefused } from "./payments";

const EXPLORER_TX = "https://explore.testnet.tempo.xyz/tx/";

const Verification = z.object({
  verification_id: z.string(),
  tap_id: z.string(),
  batch_id: z.string(),
  batch_code: z.string(),
  product_name: z.string(),
  vendor_name: z.string(),
  coa_url: z.string(),
  sku: z.string(),
  price: z.string(),
  payer: z.string(),
  tx_hash: z.string(),
});

const Order = z.object({
  order_id: z.string(),
  tap_id: z.string(),
  amount: z.string(),
  payer: z.string(),
  tx_hash: z.string(),
  explorer_url: z.string(),
  already_ordered: z.boolean(),
});

const ErrorBody = z.object({ error: z.string() });

type StoreReply<T> =
  | { kind: "ok"; body: T }
  | { kind: "error"; status: number; error: string | undefined }
  | { kind: "refused"; reason: string }
  | { kind: "failed"; message: string };

const config = parseConfig(process.env);
const wallet = createPaidFetch(config);

async function post<S extends z.ZodTypeAny>(
  path: string,
  body: Record<string, string>,
  schema: S,
): Promise<StoreReply<z.infer<S>>> {
  let response: Response;
  try {
    response = await wallet.fetch(`${config.storeUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof PaymentRefused) return { kind: "refused", reason: error.message };
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (response.ok) {
    const parsed = schema.safeParse(json);
    if (parsed.success) return { kind: "ok", body: parsed.data };
    return { kind: "error", status: response.status, error: "malformed_response" };
  }
  const error = ErrorBody.safeParse(json);
  return {
    kind: "error",
    status: response.status,
    error: error.success ? error.data.error : undefined,
  };
}

function reply(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

function describeError(status: number, error: string | undefined): string {
  return `The Demo Store answered HTTP ${status}${error === undefined ? "" : ` (${error})`}.`;
}

function verifyResult(result: StoreReply<z.infer<typeof Verification>>): CallToolResult {
  switch (result.kind) {
    case "ok": {
      const v = result.body;
      return reply(
        [
          "Res Labs verified this tap. The verification fee was paid from the agent's wallet.",
          `verification_id: ${v.verification_id}`,
          `Product: ${v.product_name}`,
          `Vendor: ${v.vendor_name}`,
          `Vendor batch: ${v.batch_code} (batch ${v.batch_id})`,
          `COA: ${v.coa_url === "" ? "COA on file at Res Labs" : v.coa_url}`,
          `Tap: ${v.tap_id}`,
          `Reorder: 1x ${v.sku} for ${v.price} pathUSD (Tempo Moderato testnet)`,
          `Payer (the agent's wallet): ${v.payer}`,
          `Verification fee transaction: ${EXPLORER_TX}${v.tx_hash}`,
          `Before calling reslabs_reorder, ask the user to confirm ${v.product_name} from ${v.vendor_name} for ${v.price} pathUSD.`,
        ].join("\n"),
      );
    }
    case "error":
      switch (result.error) {
        case "bad_link":
          return reply(
            'That is not a Res Labs share link. Ask the user for the 5-minute link from "Copy the 5-minute link" on verify.reslabs.ai.',
            true,
          );
        case "link_expired":
          return reply(
            "The share link has expired; links last 5 minutes after the tap. Ask the user to tap the product again and share a fresh link.",
            true,
          );
        case "not_eligible":
          return reply(
            "Res Labs did not confirm this tap for the demo product, so it cannot be reordered here.",
            true,
          );
        case "reslabs_unavailable":
          return reply(
            "Res Labs could not be reached to check the link. Nothing was paid. Try again in a moment.",
            true,
          );
        default:
          return reply(
            `${describeError(result.status, result.error)} The tap was not verified.`,
            true,
          );
      }
    case "refused":
      return reply(
        `The agent's wallet refused to pay: ${result.reason}. Nothing was signed.`,
        true,
      );
    case "failed":
      return reply(`The verification request failed: ${result.message}`, true);
  }
}

function reorderResult(result: StoreReply<z.infer<typeof Order>>): CallToolResult {
  switch (result.kind) {
    case "ok": {
      const o = result.body;
      return reply(
        [
          o.already_ordered
            ? "This tap was already reordered. No new payment was made; here is the existing order."
            : `Reorder placed. ${o.amount} pathUSD was paid from the agent's wallet.`,
          `order_id: ${o.order_id}`,
          `Amount: ${o.amount} pathUSD`,
          `Payer (the agent's wallet): ${o.payer}`,
          `Transaction: ${o.explorer_url}`,
          `already_ordered: ${o.already_ordered}`,
        ].join("\n"),
      );
    }
    case "error":
      switch (result.error) {
        case "settlement_pending":
          return reply("Payment is settling: check again in a minute; do not pay again", true);
        case "needs_review":
          return reply("Payment needs manual review: do not pay again", true);
        case "payment_not_settled":
          return reply(
            "The payment did not go through; you may ask the user whether to try again",
            true,
          );
        case "verification_expired":
          return reply("Verify the tap again", true);
        case "unknown_verification":
          return reply(
            "The Demo Store does not know this verification_id. Verify the tap again.",
            true,
          );
        case "credential_reused":
          return reply(
            "The Demo Store already received this payment. Do not pay again; tell the user.",
            true,
          );
        default:
          return reply(
            `${describeError(result.status, result.error)} The reorder did not complete. Do not pay again; tell the user.`,
            true,
          );
      }
    case "refused":
      return reply(
        `The agent's wallet refused to pay: ${result.reason}. Nothing was signed.`,
        true,
      );
    case "failed":
      return reply(
        `The reorder request failed: ${result.message}. A payment may already be in flight. Do not pay again; tell the user.`,
        true,
      );
  }
}

const server = new McpServer({ name: "reslabs-reup", version: "0.1.0" });

server.registerTool(
  "reslabs_verify_tap",
  {
    title: "Verify a Res Labs tap",
    description:
      "Check a Res Labs verified-tap share link (the 5-minute link from verify.reslabs.ai) with the Demo Store. " +
      "Pays a $0.001 pathUSD verification fee on Tempo Moderato testnet from the agent's wallet. " +
      "Returns the verification_id, product, vendor, vendor batch, COA, reorder price, payer and transaction hash.",
    inputSchema: {
      link: z.string().describe("The 5-minute share link the user copied from verify.reslabs.ai"),
    },
  },
  async ({ link }) => verifyResult(await post("/api/verify", { link }, Verification)),
);

server.registerTool(
  "reslabs_reorder",
  {
    title: "Reorder the verified product",
    description:
      "Buy one more of the product from a reslabs_verify_tap result, paying the reorder price in pathUSD on Tempo Moderato testnet from the agent's wallet. " +
      "Call this only after the user has explicitly confirmed the product, the vendor and the price in this conversation. " +
      "Never call it again to retry a payment: when it reports a settling, under-review or failed payment, tell the user and let them decide.",
    inputSchema: {
      verification_id: z.string().describe("The verification_id returned by reslabs_verify_tap"),
    },
    _meta: { "anthropic/requiresUserInteraction": true },
  },
  async ({ verification_id }) =>
    reorderResult(await post("/api/reorder", { verification_id }, Order)),
);

await server.connect(new StdioServerTransport());
console.error(
  `reslabs-reup MCP server on stdio. Agent wallet ${wallet.address}, store ${config.storeUrl}`,
);
