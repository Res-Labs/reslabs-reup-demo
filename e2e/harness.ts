import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PATH_USD } from "@reup/chain-proof";
import { type Address, createPublicClient, erc20Abi, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..");
export const MODERATO_RPC = "https://rpc.moderato.tempo.xyz";
export const EXPLORER_TX = "https://explore.testnet.tempo.xyz/tx/";

const STORE_DIR = path.join(REPO_ROOT, "apps/store");
const NEXT_BIN = path.join(STORE_DIR, "node_modules/.bin/next");
const TSX_BIN = path.join(REPO_ROOT, "node_modules/.bin/tsx");
const MCP_ENTRY = path.join(REPO_ROOT, "apps/mcp/dist/index.js");

export interface Wallet {
  pk: Hex;
  address: Address;
}

export interface Keys {
  recipient: Wallet;
  agents: Wallet[];
  mppSecretKey: string;
}

export function loadKeys(): Keys {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, ".e2e/keys.json"), "utf8")) as Keys;
}

export const chain = createPublicClient({ chain: tempoModerato, transport: http(MODERATO_RPC) });

export async function pathUsdBalance(address: Address, blockNumber?: bigint): Promise<bigint> {
  return chain.readContract({
    address: PATH_USD,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
    blockNumber,
  });
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`, { cause: lastError });
}

export interface ToolResult {
  isError: boolean;
  text: string;
}

export interface McpClient {
  callTool(name: string, args: Record<string, string>): Promise<ToolResult>;
  close(): Promise<void>;
}

/** Reads `label: value` from an MCP tool's text reply. */
export function toolField(text: string, label: string): string {
  const line = text.split("\n").find((l) => l.startsWith(`${label}: `));
  if (line === undefined) throw new Error(`Tool reply has no "${label}" line:\n${text}`);
  return line.slice(label.length + 2);
}

export interface StackOptions {
  /** Store's Tempo RPC, e.g. a fault proxy in front of Moderato. */
  rpcUrl?: string;
  /** Defaults to a fresh address, so balance deltas are not shared with concurrent runs. */
  recipient?: Address;
  demoPrice?: string;
}

export interface Stack {
  runId: string;
  runDir: string;
  storeUrl: string;
  mockUrl: string;
  dbPath: string;
  recipient: Address;
  batchId: string;
  mint(batchId?: string): Promise<string>;
  mcpClient(agentKey: Hex): Promise<McpClient>;
  restartStore(): Promise<void>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}

function launch(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; log: string },
): ChildProcess {
  const out = createWriteStream(opts.log, { flags: "a" });
  // Own process group, so stop() also reaches the children tsx and next spawn.
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  return child;
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => true);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-child.pid, signal);
    } catch {}
    if (await Promise.race([exited, sleep(5_000, false)])) return;
  }
}

export async function startStack(opts: StackOptions = {}): Promise<Stack> {
  if (!existsSync(MCP_ENTRY))
    throw new Error(`${MCP_ENTRY} is missing: run pnpm --filter @reup/mcp build`);
  const keys = loadKeys();
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runDir = path.join(REPO_ROOT, ".e2e", runId);
  mkdirSync(runDir, { recursive: true });
  const [mockPort, storePort] = [await freePort(), await freePort()];
  const mockUrl = `http://localhost:${mockPort}`;
  const storeUrl = `http://127.0.0.1:${storePort}`;
  const recipient =
    opts.recipient ?? privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`).address;
  const batchId = randomUUID();
  const dbPath = path.join(runDir, "store.db");
  const log = (name: string) => path.join(runDir, `${name}.log`);

  const storeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    STORE_DIST_DIR: path.relative(STORE_DIR, path.join(runDir, "next")),
    MPP_SECRET_KEY: keys.mppSecretKey,
    MPP_RECIPIENT: recipient,
    DEMO_BATCH_ID: batchId,
    DEMO_SKU: "DEMO-10MG",
    DEMO_PRICE: opts.demoPrice ?? "1.00",
    RESLABS_LINK_ORIGIN: mockUrl,
    RESLABS_SESSION_URL: `${mockUrl}/v/p/session`,
    TEMPO_RPC_URL: opts.rpcUrl ?? MODERATO_RPC,
    STORE_DB_PATH: dbPath,
  };

  const children: ChildProcess[] = [];
  let store: ChildProcess | undefined;

  const startStore = async () => {
    store = launch(NEXT_BIN, ["start", "-p", String(storePort), "-H", "127.0.0.1"], {
      cwd: STORE_DIR,
      env: storeEnv,
      log: log("store"),
    });
    children.push(store);
    await waitFor(
      async () => ((await fetch(`${storeUrl}/`)).status === 200 ? true : undefined),
      60_000,
      `store on ${storeUrl}`,
    );
  };

  const stop = async () => {
    await Promise.all(children.map(kill));
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  const onSignal = () => {
    void stop().finally(() => process.exit(130));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    children.push(
      launch(TSX_BIN, ["scripts/mock-session.ts"], {
        cwd: REPO_ROOT,
        env: { ...process.env, DEMO_BATCH_ID: batchId, MOCK_PORT: String(mockPort) },
        log: log("mock"),
      }),
    );
    const build = launch(NEXT_BIN, ["build"], { cwd: STORE_DIR, env: storeEnv, log: log("build") });
    children.push(build);
    const [code] = await once(build, "exit");
    if (code !== 0) throw new Error(`next build exited ${code}; see ${log("build")}`);
    await waitFor(async () => (await fetch(`${mockUrl}/`)) && true, 30_000, `mock on ${mockUrl}`);
    await startStore();
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    runId,
    runDir,
    storeUrl,
    mockUrl,
    dbPath,
    recipient,
    batchId,
    stop,
    async restartStore() {
      if (store !== undefined) await kill(store);
      await startStore();
    },
    async mint(mintBatchId?: string) {
      const response = await fetch(`${mockUrl}/mint`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: mintBatchId === undefined ? "" : JSON.stringify({ batch_id: mintBatchId }),
      });
      const body = (await response.json()) as { link?: string };
      if (response.status !== 200 || typeof body.link !== "string") {
        throw new Error(`mint failed: HTTP ${response.status} ${JSON.stringify(body)}`);
      }
      return body.link;
    },
    async mcpClient(agentKey: Hex) {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [MCP_ENTRY],
        env: {
          PATH: process.env.PATH ?? "",
          AGENT_KEY: agentKey,
          STORE_URL: storeUrl,
          MPP_RECIPIENT: recipient,
        },
        stderr: "pipe",
      });
      transport.stderr?.pipe(createWriteStream(log("mcp"), { flags: "a" }));
      const client = new Client({ name: "reup-e2e", version: "0.0.0" });
      await client.connect(transport);
      return {
        async callTool(name, args) {
          const result = await client.callTool({ name, arguments: args }, undefined, {
            timeout: 180_000,
          });
          const content = result.content as { type: string; text?: string }[];
          return {
            isError: result.isError === true,
            text: content.map((c) => c.text ?? "").join("\n"),
          };
        },
        close: () => client.close(),
      };
    },
  };
}
