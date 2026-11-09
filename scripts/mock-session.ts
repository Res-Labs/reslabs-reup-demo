import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const defaultBatchId = process.env.MOCK_BATCH_ID?.trim() || "6f1d2c3b-4a59-4e68-9d7c-8b0a1f2e3d4c";
const defaultBatchStatus = "shipped";
const portRaw = process.env.MOCK_PORT ?? "4010";
const port = Number(portRaw);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`mock-session: MOCK_PORT must be a valid port, got "${portRaw}"`);
  process.exit(1);
}

const origin = `http://localhost:${port}`;
const LINK_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 4096;

interface MintedLink {
  tapId: string;
  batchId: string;
  batchStatus: string;
  mintedAt: number;
}

const links = new Map<string, MintedLink>();

function fixture(link: MintedLink) {
  return {
    variant: "success",
    verified: true,
    tap: { id: link.tapId },
    batch: {
      id: link.batchId,
      batch_code: "DEMO-0001",
      product_name: "Demo Compound 10 mg",
      status: link.batchStatus,
    },
    provenance_summary: { vendor_name: "Demo Vendor" },
    coa: { lab_coa_url: "https://example.com/coa/demo.pdf" },
  };
}

function liveLink(token: string | null): MintedLink | undefined {
  if (!token) return undefined;
  const link = links.get(token);
  if (!link) return undefined;
  if (Date.now() - link.mintedAt > LINK_TTL_MS) {
    links.delete(token);
    return undefined;
  }
  return link;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type MintRequest =
  | { ok: true; batchId: string; batchStatus: string }
  | { ok: false; error: string };

function parseMintBody(raw: string): MintRequest {
  if (raw.trim() === "") {
    return { ok: true, batchId: defaultBatchId, batchStatus: defaultBatchStatus };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "body must be JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const { batch_id: batchId = defaultBatchId, batch_status: batchStatus = defaultBatchStatus } =
    parsed as Record<string, unknown>;
  if (typeof batchId !== "string" || batchId.trim() === "") {
    return { ok: false, error: "batch_id must be a non-empty string" };
  }
  if (typeof batchStatus !== "string" || batchStatus.trim() === "") {
    return { ok: false, error: "batch_status must be a non-empty string" };
  }
  return { ok: true, batchId: batchId.trim(), batchStatus: batchStatus.trim() };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", origin);

  if (req.method === "POST" && url.pathname === "/mint") {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      return sendJson(res, 413, { error: "body too large" });
    }
    const mint = parseMintBody(raw);
    if (!mint.ok) return sendJson(res, 400, { error: mint.error });
    const token = randomBytes(16).toString("base64url");
    const link: MintedLink = {
      tapId: randomUUID(),
      batchId: mint.batchId,
      batchStatus: mint.batchStatus,
      mintedAt: Date.now(),
    };
    links.set(token, link);
    console.log(`minted tap ${link.tapId} for batch ${link.batchId}`);
    return sendJson(res, 200, { link: `${origin}/v/p?t=${token}` });
  }

  if (req.method === "GET" && url.pathname === "/v/p/session") {
    const link = liveLink(url.searchParams.get("t"));
    if (!link) return sendJson(res, 401, { error: "unauthorized" });
    return sendJson(res, 200, fixture(link));
  }

  if (req.method === "GET" && url.pathname === "/v/p") {
    const verified = liveLink(url.searchParams.get("t")) !== undefined;
    res.writeHead(verified ? 200 : 401, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Mock verify</title><p>${verified ? "Verified (mock)" : "Link unknown or expired (mock)"}</p>`,
    );
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error("mock-session: request failed", err);
    if (!res.headersSent) sendJson(res, 500, { error: "internal" });
    else res.end();
  });
}).listen(port, () => {
  console.log(`mock-session listening on ${origin}`);
});
