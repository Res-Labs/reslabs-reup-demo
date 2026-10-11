import type { Address } from "@reup/chain-proof";
import { getAddress, isAddress, parseUnits } from "viem";

export const PATH_USD_DECIMALS = 6;

export interface Config {
  mppSecretKey: string;
  mppRecipient: Address;
  demoBatchIds: readonly string[];
  demoSku: string;
  demoPrice: string;
  demoPriceUnits: bigint;
  reslabsLinkOrigin: string;
  reslabsSessionUrl: string;
  tempoRpcUrl: string;
  databaseUrl: string;
  /** When set, `GET /api/cron/reconcile` requires `Authorization: Bearer <cronSecret>`. */
  cronSecret: string | undefined;
  /** Sent as `x-reslabs-reup-key` on session reads, when Res Labs gave this store an edge key. */
  reslabsEdgeKey: string | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const invalid: string[] = [];
  const read = (name: string, valid: (value: string) => boolean): string => {
    const value = env[name]?.trim() ?? "";
    if (!valid(value)) invalid.push(name);
    return value;
  };
  const url = (value: string) => URL.canParse(value);

  const mppSecretKey = read("MPP_SECRET_KEY", (value) => value !== "");
  const mppRecipient = read("MPP_RECIPIENT", (value) => isAddress(value, { strict: false }));
  const demoBatchIds = read("DEMO_BATCH_IDS", (value) =>
    value.split(",").every((id) => isUuid(id.trim())),
  )
    .split(",")
    .map((id) => id.trim());
  const demoSku = read("DEMO_SKU", (value) => value !== "");
  const demoPrice = read(
    "DEMO_PRICE",
    (value) => /^\d+(\.\d{1,6})?$/.test(value) && parseUnits(value, PATH_USD_DECIMALS) > 0n,
  );
  const reslabsLinkOrigin = read("RESLABS_LINK_ORIGIN", url);
  const reslabsSessionUrl = read("RESLABS_SESSION_URL", url);
  const tempoRpcUrl = read("TEMPO_RPC_URL", url);
  const databaseUrl = read(
    "DATABASE_URL",
    (value) => URL.canParse(value) && /^postgres(ql)?:$/.test(new URL(value).protocol),
  );

  if (invalid.length > 0) {
    throw new Error(`Missing or invalid store environment variables: ${invalid.join(", ")}`);
  }

  return {
    mppSecretKey,
    mppRecipient: getAddress(mppRecipient),
    demoBatchIds,
    demoSku,
    demoPrice,
    demoPriceUnits: parseUnits(demoPrice, PATH_USD_DECIMALS),
    reslabsLinkOrigin: new URL(reslabsLinkOrigin).origin,
    reslabsSessionUrl,
    tempoRpcUrl,
    databaseUrl,
    cronSecret: env.CRON_SECRET?.trim() || undefined,
    reslabsEdgeKey: env.RESLABS_EDGE_KEY?.trim() || undefined,
  };
}

let parsed: Config | undefined;

// Parsed on first property read, so `next build` can import server modules without runtime env.
export const config: Config = new Proxy({} as Config, {
  get(_target, key) {
    parsed ??= parseConfig(process.env);
    return parsed[key as keyof Config];
  },
});
