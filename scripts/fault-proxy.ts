import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const FAULT_MODES = [
  "pass",
  "drop-after-forward",
  "hang-after-forward",
  "drop-before-forward",
  "strip-receipt-logs",
] as const;

export type FaultMode = (typeof FAULT_MODES)[number];

export interface FaultProxyOptions {
  upstream: string;
  port?: number;
}

export interface FaultProxy {
  url: string;
  setMode(mode: FaultMode): void;
  stop(): Promise<void>;
  readonly seenSendRaw: number;
}

const RAW_TX_METHODS: Record<string, true> = {
  eth_sendRawTransaction: true,
  eth_sendRawTransactionSync: true,
};
// mppx's tempo charge broadcasts with eth_sendRawTransactionSync (waitForConfirmation defaults
// to true) and checks the transfer logs on the receipt that call returns, so it is stripped too.
const RECEIPT_METHODS: Record<string, true> = {
  eth_getTransactionReceipt: true,
  eth_sendRawTransactionSync: true,
};

interface JsonRpcMessage {
  id?: unknown;
  method?: unknown;
  result?: unknown;
}

interface Call {
  id: unknown;
  method: string;
}

function parseMessages(text: string): { parsed: unknown; messages: JsonRpcMessage[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { parsed: undefined, messages: [] };
  }
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const messages = items.filter(
    (item): item is JsonRpcMessage => typeof item === "object" && item !== null,
  );
  return { parsed, messages };
}

function stripReceiptLogs(responseBody: string, calls: Call[]): string {
  const receiptIds = new Set(calls.filter((c) => RECEIPT_METHODS[c.method]).map((c) => c.id));
  if (receiptIds.size === 0) return responseBody;
  const { parsed, messages } = parseMessages(responseBody);
  if (parsed === undefined) return responseBody;
  for (const { id, result } of messages) {
    if (receiptIds.has(id) && typeof result === "object" && result && "logs" in result) {
      result.logs = [];
    }
  }
  return JSON.stringify(parsed);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFaultProxy({
  upstream,
  port = 0,
}: FaultProxyOptions): Promise<FaultProxy> {
  let mode: FaultMode = "pass";
  let seenSendRaw = 0;

  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const activeMode = mode;
    const body = await readBody(req);
    const calls = parseMessages(body).messages.flatMap(({ id, method }) =>
      typeof method === "string" ? [{ id, method }] : [],
    );
    const sendsRaw = calls.filter((c) => RAW_TX_METHODS[c.method]).length;
    seenSendRaw += sendsRaw;
    const fault = sendsRaw > 0 ? activeMode : "pass";

    if (fault === "drop-before-forward") {
      req.socket.destroy();
      return;
    }

    let status: number;
    let text: string;
    try {
      const upstreamRes = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      status = upstreamRes.status;
      text = await upstreamRes.text();
    } catch (error) {
      res.writeHead(502, { "content-type": "text/plain" }).end(`fault-proxy upstream: ${error}`);
      return;
    }

    if (fault === "drop-after-forward") {
      req.socket.destroy();
      return;
    }
    // Leaving the response open is the fault; stop() destroys the socket.
    if (fault === "hang-after-forward") return;

    if (activeMode === "strip-receipt-logs") text = stripReceiptLogs(text, calls);
    res.writeHead(status, { "content-type": "application/json" }).end(text);
  });

  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const { port: boundPort } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${boundPort}`,
    setMode(next) {
      mode = next;
    },
    async stop() {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
    get seenSendRaw() {
      return seenSendRaw;
    },
  };
}

function isFaultMode(value: string): value is FaultMode {
  return (FAULT_MODES as readonly string[]).includes(value);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      upstream: { type: "string" },
      port: { type: "string", default: "0" },
      mode: { type: "string", default: "pass" },
    },
  });
  const usage = `usage: tsx scripts/fault-proxy.ts --upstream <url> [--port <n>] [--mode <${FAULT_MODES.join("|")}>]`;
  if (!values.upstream || !URL.canParse(values.upstream)) {
    console.error(`fault-proxy: --upstream must be a URL\n${usage}`);
    process.exit(1);
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`fault-proxy: --port must be a valid port, got "${values.port}"\n${usage}`);
    process.exit(1);
  }
  if (!isFaultMode(values.mode)) {
    console.error(`fault-proxy: unknown --mode "${values.mode}"\n${usage}`);
    process.exit(1);
  }

  const proxy = await startFaultProxy({ upstream: values.upstream, port });
  proxy.setMode(values.mode);
  console.log(`fault-proxy listening on ${proxy.url} -> ${values.upstream} (mode=${values.mode})`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.log(`fault-proxy stopping (seenSendRaw=${proxy.seenSendRaw})`);
      void proxy.stop().then(() => process.exit(0));
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
