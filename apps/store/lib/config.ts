import path from "node:path";
import type { Address } from "@reup/chain-proof";
import { getAddress, isAddress, parseUnits } from "viem";

export const PATH_USD_DECIMALS = 6;

export interface Config {
  mppSecretKey: string;
  mppRecipient: Address;
  demoBatchId: string;
  demoSku: string;
  demoPrice: string;
  demoPriceUnits: bigint;
  reslabsLinkOrigin: string;
  reslabsSessionUrl: string;
  tempoRpcUrl: string;
  storeDbPath: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function parseConfig(env: NodeJS.ProcessEnv, cwd: string): Config {
  const invalid: string[] = [];
  const read = (name: string, valid: (value: string) => boolean): string => {
    const value = env[name]?.trim() ?? "";
    if (!valid(value)) invalid.push(name);
    return value;
  };
  const url = (value: string) => URL.canParse(value);

  const mppSecretKey = read("MPP_SECRET_KEY", (value) => value !== "");
  const mppRecipient = read("MPP_RECIPIENT", (value) => isAddress(value, { strict: false }));
  const demoBatchId = read("DEMO_BATCH_ID", isUuid);
  const demoSku = read("DEMO_SKU", (value) => value !== "");
  const demoPrice = read(
    "DEMO_PRICE",
    (value) => /^\d+(\.\d{1,6})?$/.test(value) && parseUnits(value, PATH_USD_DECIMALS) > 0n,
  );
  const reslabsLinkOrigin = read("RESLABS_LINK_ORIGIN", url);
  const reslabsSessionUrl = read("RESLABS_SESSION_URL", url);
  const tempoRpcUrl = read("TEMPO_RPC_URL", url);
  const storeDbPath = env.STORE_DB_PATH?.trim() || "data/store.db";

  if (invalid.length > 0) {
    throw new Error(`Missing or invalid store environment variables: ${invalid.join(", ")}`);
  }

  return {
    mppSecretKey,
    mppRecipient: getAddress(mppRecipient),
    demoBatchId,
    demoSku,
    demoPrice,
    demoPriceUnits: parseUnits(demoPrice, PATH_USD_DECIMALS),
    reslabsLinkOrigin: new URL(reslabsLinkOrigin).origin,
    reslabsSessionUrl,
    tempoRpcUrl,
    storeDbPath: path.resolve(cwd, storeDbPath),
  };
}

let parsed: Config | undefined;

// Parsed on first property read, so `next build` can import server modules without runtime env.
export const config: Config = new Proxy({} as Config, {
  get(_target, key) {
    parsed ??= parseConfig(process.env, process.cwd());
    return parsed[key as keyof Config];
  },
});
